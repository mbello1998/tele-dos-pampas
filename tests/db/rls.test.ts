import type { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { connect } from '../../scripts/db/client'
import { ID, FIXTURE_SQL, actAs, asOwner, attempt, readAs, sorted, type Attempt, type Who } from './rls-helpers'

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 })

let db: Client

const admin: Who = { uid: ID.admin }
const clientA: Who = { uid: ID.clientA }
const clientB: Who = { uid: ID.clientB }
const courierQ1: Who = { uid: ID.courierQ1 }
const courierQ2: Who = { uid: ID.courierQ2 }
const courierA1: Who = { uid: ID.courierA1 }
const merchant1: Who = { uid: ID.merchant1 }
const merchant2: Who = { uid: ID.merchant2 }
const fleet1: Who = { uid: ID.fleetOwner1 }
const fleet2: Who = { uid: ID.fleetOwner2 }

const FIXTURE_ORDERS = [ID.oQueueQ, ID.oQueueA, ID.oTakenQ2, ID.oFleet1, ID.oShop1New, ID.oShop1Draft]
const orderIds = (who: Who) =>
  readAs(db, who, `select id from orders where id in (${FIXTURE_ORDERS.map((i) => `'${i}'`).join(',')})`)

const count = async (who: Who, from: string, where = 'true') => {
  await actAs(db, who)
  const r = await db.query(`select count(*)::int as n from ${from} where ${where}`)
  return r.rows[0].n as number
}

/** A write counts as refused when it errors (privilege or RLS or trigger) OR touches zero rows. */
const expectRefused = (a: Attempt, label = '') => {
  if (a.ok) expect(a.rowCount, `${label} should have touched 0 rows`).toBe(0)
}
/** A write refused loudly: an error with the insufficient_privilege code (RLS violation, privilege or trigger). */
const expectForbidden = (a: Attempt, label = '') => {
  expect(a.ok, `${label} should have been refused`).toBe(false)
  if (!a.ok) expect(a.code, `${label}: ${a.message}`).toBe('42501')
}

beforeAll(async () => {
  db = await connect()
})
afterAll(async () => {
  await db.end()
})

// Isolation: every policy test runs in a transaction that is always rolled back.
describe('políticas RLS', () => {
  beforeEach(async () => {
    await db.query('begin')
    await db.query(FIXTURE_SQL)
  })
  afterEach(async () => {
    await db.query('rollback')
  })

  // ---------------------------------------------------------------- estrutura
  describe('estrutura', () => {
    test('toda tabela pública tem RLS e pelo menos uma policy (exceto schema_migrations)', async () => {
      const t = await asOwner<{ relname: string; n: number }>(
        db,
        `select c.relname, (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) n
         from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
         where ns.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity order by 1`,
      )
      expect(t.length).toBeGreaterThanOrEqual(21)
      expect(t.filter((r) => r.n === 0).map((r) => r.relname)).toEqual(['schema_migrations'])
    })

    test('helpers são security definer com search_path fixo', async () => {
      const r = await asOwner<{ proname: string; prosecdef: boolean; proconfig: string[] | null; rt: string }>(
        db,
        `select p.proname, p.prosecdef, p.proconfig, pg_get_function_result(p.oid) rt from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('current_role', 'is_admin', 'audit_write')`,
      )
      expect(r.map((x) => x.proname).sort()).toEqual(['audit_write', 'current_role', 'is_admin'])
      for (const f of r) {
        expect(f.prosecdef, f.proname).toBe(true)
        expect((f.proconfig ?? []).join(','), f.proname).toMatch(/search_path=""|search_path=''/)
      }
      expect(r.find((x) => x.proname === 'current_role')!.rt).toBe('user_role')
      expect(r.find((x) => x.proname === 'is_admin')!.rt).toBe('boolean')
    })

    test('nenhuma policy usa current_role sem qualificar (a palavra-chave devolve o papel do Postgres)', async () => {
      const r = await asOwner<{ policyname: string; q: string | null; w: string | null }>(
        db,
        `select policyname, qual q, with_check w from pg_policies where schemaname = 'public'`,
      )
      expect(r.length).toBeGreaterThan(40)
      for (const p of r) {
        const text = `${p.q ?? ''} ${p.w ?? ''}`
        expect(text, p.policyname).not.toMatch(/\bCURRENT_ROLE\b/)
        expect(text, p.policyname).not.toMatch(/(?<![."\w])current_role\b/)
      }
    })

    test('anon só tem privilégio de SELECT em settings; ninguém tem TRUNCATE; audit_log é append-only nos privilégios', async () => {
      const anon = await asOwner<{ table_name: string; privilege_type: string }>(
        db,
        `select table_name, privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and grantee = 'anon'`,
      )
      expect(anon).toEqual([{ table_name: 'settings', privilege_type: 'SELECT' }])
      const trunc = await asOwner(
        db,
        `select grantee, table_name from information_schema.role_table_grants
         where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER')`,
      )
      expect(trunc).toEqual([])
      const audit = await asOwner<{ grantee: string; privilege_type: string }>(
        db,
        `select grantee, privilege_type from information_schema.role_table_grants
         where table_schema = 'public' and table_name = 'audit_log' and grantee in ('anon', 'authenticated', 'service_role')
         order by 1, 2`,
      )
      expect(audit).toEqual([{ grantee: 'authenticated', privilege_type: 'SELECT' }, { grantee: 'service_role', privilege_type: 'SELECT' }])
    })
  })

  // -------------------------------------------- matriz: quem enxerga o quê, tabela por tabela
  describe('matriz de leitura por papel', () => {
    type K = 'anon' | 'client' | 'courier' | 'merchant' | 'fleet' | 'admin'
    const who: Record<K, Who> = { anon: 'anon', client: clientA, courier: courierQ1, merchant: merchant1, fleet: fleet1, admin }
    // table [, where] -> roles that must see at least one row (fixtures put at least one row where it is expected)
    const rows: [string, string, K[]][] = [
      ['merchants', 'true', ['client', 'merchant', 'admin']],
      ['merchant_hours', 'true', ['client', 'merchant', 'admin']],
      ['catalog_categories', 'true', ['client', 'merchant', 'admin']],
      ['catalog_items', 'true', ['client', 'merchant', 'admin']],
      ['item_option_groups', 'true', ['client', 'merchant', 'admin']],
      ['item_options', 'true', ['client', 'merchant', 'admin']],
      ['couriers', 'true', ['courier', 'fleet', 'admin']],
      ['fleets', 'true', ['fleet', 'admin']],
      ['addresses', 'true', ['client', 'admin']],
      ['zones', 'true', ['client', 'courier', 'merchant', 'fleet', 'admin']],
      ['orders', 'true', ['client', 'courier', 'merchant', 'fleet', 'admin']],
      ['order_items', 'true', ['client', 'courier', 'merchant', 'admin']], // never fleet
      ['order_events', 'true', ['client', 'courier', 'merchant', 'fleet', 'admin']],
      ['courier_positions', 'true', ['courier', 'admin']],
      ['pricing_rules', 'true', ['client', 'courier', 'fleet', 'admin']], // never merchant
      ['fx_rates', 'true', ['client', 'courier', 'merchant', 'fleet', 'admin']],
      ['settings', `key = 'rls_fixture_private'`, ['admin']],
      ['audit_log', 'true', ['admin']],
      ['status_transitions', 'true', ['client', 'courier', 'merchant', 'fleet', 'admin']],
      ['profiles', `full_name = 'Cliente B'`, ['admin']], // somebody else's profile
    ]
    for (const [table, where, allowed] of rows) {
      test(`${table}: leem ${allowed.join(', ')}; os demais papéis recebem zero linhas`, async () => {
        for (const k of Object.keys(who) as K[]) {
          let n: number
          if (k === 'anon' && table !== 'settings') {
            // anon holds no privilege on the table at all (settings aside): refused, not merely filtered
            await actAs(db, 'anon')
            const a = await attempt(db, `select count(*)::int n from ${table}`)
            expectForbidden(a, `anon ${table}`)
            continue
          }
          n = await count(who[k], table, where)
          if (allowed.includes(k)) expect(n, `${k} deve ver ${table}`).toBeGreaterThan(0)
          else expect(n, `${k} NÃO deve ver ${table}`).toBe(0)
        }
      })
    }
  })

  // ------------------------------------------------------------------- client
  describe('client', () => {
    test('client lê o próprio pedido', async () => {
      expect(await orderIds(clientA)).toEqual(sorted(ID.oQueueQ, ID.oTakenQ2, ID.oFleet1))
    })

    test('client NÃO lê pedido de outro client', async () => {
      expect(await orderIds(clientB)).toEqual(sorted(ID.oQueueA, ID.oShop1New, ID.oShop1Draft))
      await actAs(db, clientA)
      const r = await db.query(`select id from orders where id = $1`, [ID.oQueueA])
      expect(r.rows).toEqual([])
    })

    test('client NÃO altera total_brl do próprio pedido (policy deixa passar a linha, o trigger recusa a coluna)', async () => {
      await actAs(db, clientA)
      for (const set of [
        'total_brl = 0.01',
        "pricing_breakdown = '{}'::jsonb",
        'fx_rate_used = 1',
        'total_charged = 0.01',
        `fx_rate_id = '${ID.fx1}'`,
        'pricing_rule_id = (select id from pricing_rules limit 1)',
        "currency_charged = 'UYU'",
        "status = 'entregue'",
        `courier_id = '${ID.courierQ1}'`,
        `client_id = '${ID.clientB}'`,
      ]) {
        expectForbidden(await attempt(db, `update orders set ${set} where id = $1`, [ID.oQueueQ]), set)
      }
      const [o] = await asOwner<{ total_brl: string; total_charged: string; status: string; courier_id: string | null; fx_rate_used: string }>(
        db, `select total_brl, total_charged, status, courier_id, fx_rate_used from orders where id = $1`, [ID.oQueueQ])
      expect(o).toMatchObject({ total_brl: '25.00', total_charged: '25.00', status: 'aguardando_motoboy', courier_id: null })
      expect(Number(o.fx_rate_used)).toBe(7.8)
      // the legitimate columns still work, proving the refusal above is column-level, not a blanket ban
      await actAs(db, clientA)
      const ok = await attempt(db, `update orders set client_notes = 'sem cebola', rating = 5 where id = $1`, [ID.oQueueQ])
      expect(ok.ok && ok.rowCount).toBe(1)
    })

    test('client NÃO altera nem cria pedido de outro client nem grava pedido direto (preço vem do servidor)', async () => {
      await actAs(db, clientA)
      expectRefused(await attempt(db, `update orders set client_notes = 'x' where id = $1`, [ID.oQueueA]), 'pedido alheio')
      expectForbidden(
        await attempt(
          db,
          `insert into orders (kind, client_id, pickup_address, dropoff_address, total_brl, total_charged, payment_method)
           values ('courier', $1, '{}', '{}', 0.01, 0.01, 'pix')`,
          [ID.clientA],
        ),
        'insert direto',
      )
      expectRefused(await attempt(db, `delete from orders where id = $1`, [ID.oQueueQ]), 'delete')
      expect((await asOwner(db, `select 1 from orders where id = $1`, [ID.oQueueQ])).length).toBe(1)
    })

    test('client só enxerga e gerencia os próprios endereços', async () => {
      expect(await readAs(db, clientA, 'select id from addresses')).toEqual([ID.addrA])
      expect(await readAs(db, clientB, 'select id from addresses')).toEqual([ID.addrB])
      await actAs(db, clientA)
      expectForbidden(await attempt(db, `insert into addresses (profile_id, city, country) values ($1, 'quarai', 'BR')`, [ID.clientB]), 'endereço em nome de outro')
      expectRefused(await attempt(db, `update addresses set label = 'x' where id = $1`, [ID.addrB]), 'update alheio')
      expectRefused(await attempt(db, `delete from addresses where id = $1`, [ID.addrB]), 'delete alheio')
      const own = await attempt(db, `insert into addresses (profile_id, city, country) values ($1, 'quarai', 'BR') returning id`, [ID.clientA])
      expect(own.ok).toBe(true)
      expect((await attempt(db, `update addresses set label = 'nova' where id = $1`, [ID.addrA])).ok).toBe(true)
      const del = await attempt(db, `delete from addresses where id = $1`, [ID.addrA])
      expect(del.ok && del.rowCount).toBe(1)
    })

    test('client lê o próprio perfil e só ele; não promove o próprio role nem status', async () => {
      expect(await readAs(db, clientA, 'select id from profiles')).toEqual([ID.clientA])
      await actAs(db, clientA)
      for (const set of ["role = 'admin'", "role = 'merchant'", "status = 'active'", `id = '${ID.clientB}'`]) {
        const a = await attempt(db, `update profiles set ${set} where id = $1`, [ID.clientA])
        if (set.startsWith('status')) expect(a.ok && a.rowCount).toBe(1) // no change at all: allowed, nothing to protect
        else expectForbidden(a, set)
      }
      const name = await attempt(db, `update profiles set full_name = 'Novo Nome', locale = 'es-UY' where id = $1`, [ID.clientA])
      expect(name.ok && name.rowCount).toBe(1)
      expectRefused(await attempt(db, `update profiles set full_name = 'hack' where id = $1`, [ID.clientB]), 'perfil alheio')
      expectForbidden(
        await attempt(db, `insert into profiles (id, role) values ('a0000000-0000-4000-8000-0000000000ee', 'client')`),
        'perfil de outro id',
      )
      const [p] = await asOwner<{ role: string }>(db, `select role from profiles where id = $1`, [ID.clientA])
      expect(p.role).toBe('client')
    })

    test('client lê lojas aprovadas e o cardápio delas, mas não loja pendente; não escreve no cardápio', async () => {
      const shops = await readAs(db, clientA, 'select id from merchants')
      expect(shops).toEqual(expect.arrayContaining([ID.shop1, ID.shop2, ID.shopOrphan]))
      expect(shops).not.toContain(ID.shopPending)
      const items = await readAs(db, clientA, 'select id from catalog_items')
      expect(items).toEqual(expect.arrayContaining([ID.item1, ID.item2, ID.itemOrphan]))
      expect(items).not.toContain(ID.itemPending)
      await actAs(db, clientA)
      expectForbidden(await attempt(db, `insert into catalog_items (merchant_id, name, price_brl) values ($1, 'x', 1)`, [ID.shop1]), 'insert item')
      expectRefused(await attempt(db, `update catalog_items set price_brl = 0.01 where id = $1`, [ID.item1]), 'update item')
      expectRefused(await attempt(db, `update merchants set status = 'approved', commission_pct = 0 where id = $1`, [ID.shop1]), 'update loja')
    })

    test('client lê os itens e eventos do próprio pedido, nunca os de outro', async () => {
      expect(await readAs(db, clientA, 'select order_id from order_items', 'order_id')).toEqual([ID.oFleet1])
      expect(await readAs(db, clientB, 'select order_id from order_items', 'order_id')).toEqual(sorted(ID.oQueueA, ID.oShop1New))
      expect(await readAs(db, clientA, 'select order_id from order_events', 'order_id')).toEqual([ID.oFleet1])
      expect(await readAs(db, clientB, 'select order_id from order_events', 'order_id')).toEqual([])
      await actAs(db, clientA)
      expectForbidden(
        await attempt(db, `insert into order_items (order_id, name_snapshot, unit_price_brl_snapshot, qty, line_total_brl) values ($1, 'x', 0.01, 1, 0.01)`, [ID.oQueueQ]),
        'insert order_items',
      )
      expectForbidden(await attempt(db, `insert into order_events (order_id, to_status) values ($1, 'entregue')`, [ID.oQueueQ]), 'insert order_events')
    })

    test('client NÃO lê couriers, fleets, posições de motoboy nem audit_log', async () => {
      for (const t of ['couriers', 'fleets', 'courier_positions', 'audit_log']) expect(await count(clientA, t), t).toBe(0)
    })
  })

  // ------------------------------------------------------------------ courier
  describe('courier', () => {
    test('courier lê pedidos aguardando na cidade onde está habilitado, mais os que aceitou', async () => {
      expect(await orderIds(courierQ1)).toEqual(sorted(ID.oQueueQ, ID.oFleet1)) // fila de Quarai + o dele
      expect(await orderIds(courierQ2)).toEqual(sorted(ID.oQueueQ, ID.oTakenQ2))
    })

    test('courier NÃO lê pedido atribuído a outro courier', async () => {
      expect(await orderIds(courierQ1)).not.toContain(ID.oTakenQ2)
      expect(await orderIds(courierQ2)).not.toContain(ID.oFleet1)
      // nem mesmo se o pedido de outro courier estiver num status "de fila"
      await asOwner(db, `update orders set status = 'aguardando_motoboy' where id = $1`, [ID.oTakenQ2])
      expect(await orderIds(courierQ1)).not.toContain(ID.oTakenQ2)
    })

    test('courier de outra cidade NÃO lê a fila de Quarai; pedido sem cidade não aparece para ninguém na fila', async () => {
      expect(await orderIds(courierA1)).toEqual([ID.oQueueA])
      await asOwner(db, `update orders set pickup_address = '{}' where id = $1`, [ID.oQueueQ])
      expect(await orderIds(courierQ1)).toEqual([ID.oFleet1])
    })

    test('courier com perfil pendente ou cadastro suspenso não lê nada', async () => {
      expect(await orderIds({ uid: ID.pendingCourier })).toEqual([])
      await asOwner(db, `update couriers set status = 'suspended' where profile_id = $1`, [ID.courierQ1])
      expect(await orderIds(courierQ1)).toEqual([])
    })

    test('courier não toma pedido por UPDATE direto (aceite é transição, não escrita) e não vê pedido em status que não é fila', async () => {
      await actAs(db, courierQ1)
      expectRefused(await attempt(db, `update orders set courier_id = $1, status = 'aceito' where id = $2`, [ID.courierQ1, ID.oQueueQ]), 'aceite direto')
      const [o] = await asOwner<{ courier_id: string | null; status: string }>(db, `select courier_id, status from orders where id = $1`, [ID.oQueueQ])
      expect(o).toEqual({ courier_id: null, status: 'aguardando_motoboy' })
      await asOwner(db, `update orders set status = 'entregue' where id = $1`, [ID.oQueueQ])
      expect(await orderIds(courierQ1)).not.toContain(ID.oQueueQ)
    })

    test('courier lê itens só dos pedidos que aceitou; não altera status, frota nem cidade do próprio cadastro', async () => {
      expect(await readAs(db, courierQ1, 'select order_id from order_items', 'order_id')).toEqual([ID.oFleet1])
      expect(await readAs(db, courierA1, 'select order_id from order_items', 'order_id')).toEqual([]) // fila de Artigas: sem itens
      await actAs(db, courierQ1)
      for (const set of ["base_city = 'artigas'", 'fleet_id = null', "status = 'pending'", 'rating_avg = 5', `profile_id = '${ID.courierQ2}'`]) {
        expectForbidden(await attempt(db, `update couriers set ${set} where profile_id = $1`, [ID.courierQ1]), set)
      }
      const on = await attempt(db, `update couriers set is_online = true, plate = 'ABC1D23' where profile_id = $1`, [ID.courierQ1])
      expect(on.ok && on.rowCount).toBe(1)
      expectRefused(await attempt(db, `update couriers set is_online = true where profile_id = $1`, [ID.courierQ2]), 'outro courier')
      expectForbidden(await attempt(db, `insert into couriers (profile_id, vehicle, base_city) values ($1, 'moto', 'quarai')`, [ID.clientA]), 'auto-cadastro')
    })

    test('courier só publica posição do próprio pedido aceito e só lê a própria', async () => {
      expect(await readAs(db, courierQ1, 'select courier_id from courier_positions', 'courier_id')).toEqual([ID.courierQ1])
      expect(await readAs(db, courierQ2, 'select courier_id from courier_positions', 'courier_id')).toEqual([])
      await actAs(db, courierQ1)
      const ins = (cid: string, oid: string | null) =>
        attempt(db, `insert into courier_positions (courier_id, order_id, lat, lng) values ($1, $2, -30.38, -56.45)`, [cid, oid])
      expect((await ins(ID.courierQ1, ID.oFleet1)).ok).toBe(true)
      expectForbidden(await ins(ID.courierQ1, ID.oQueueQ), 'pedido que não é dele')
      expectForbidden(await ins(ID.courierQ2, ID.oFleet1), 'posição em nome de outro')
    })
  })

  // ----------------------------------------------------------------- merchant
  describe('merchant', () => {
    test('merchant lê apenas pedidos da própria loja (e não os ainda não enviados)', async () => {
      expect(await orderIds(merchant1)).toEqual(sorted(ID.oFleet1, ID.oShop1New)) // sem oShop1Draft (criado)
      expect(await orderIds(merchant2)).toEqual([ID.oQueueA])
      await actAs(db, merchant1)
      expectRefused(await attempt(db, `update orders set client_notes = 'x' where id = $1`, [ID.oShop1New]), 'update')
      expectRefused(await attempt(db, `delete from orders where id = $1`, [ID.oShop1New]), 'delete')
    })

    test('merchant NÃO lê catalog_items de outro merchant (nem escreve neles)', async () => {
      expect(await readAs(db, merchant1, 'select id from catalog_items')).toEqual([ID.item1])
      expect(await readAs(db, merchant2, 'select id from catalog_items')).toEqual(sorted(ID.item2, ID.itemPending))
      expect(await readAs(db, merchant1, 'select id from catalog_categories')).toEqual([ID.cat1])
      expect(await readAs(db, merchant1, 'select id from item_option_groups')).toEqual([ID.group1])
      expect(await readAs(db, merchant1, 'select id from item_options')).toEqual([ID.opt1])
      expect(await readAs(db, merchant1, 'select id from merchant_hours')).toHaveLength(1)
      await actAs(db, merchant1)
      expectForbidden(await attempt(db, `insert into catalog_items (merchant_id, name, price_brl) values ($1, 'x', 1)`, [ID.shop2]), 'insert na loja alheia')
      expectRefused(await attempt(db, `update catalog_items set price_brl = 0.01 where id = $1`, [ID.item2]), 'update item alheio')
      expectRefused(await attempt(db, `delete from catalog_items where id = $1`, [ID.item2]), 'delete item alheio')
      expectForbidden(await attempt(db, `update catalog_items set merchant_id = $1 where id = $2`, [ID.shop2, ID.item1]), 'mover item para loja alheia')
      expectForbidden(await attempt(db, `insert into catalog_items (merchant_id, category_id, name, price_brl) values ($1, $2, 'x', 1)`, [ID.shop1, ID.cat2]), 'categoria de outra loja')
      expectForbidden(await attempt(db, `insert into item_option_groups (item_id, name) values ($1, 'x')`, [ID.item2]), 'grupo em item alheio')
      expectForbidden(await attempt(db, `insert into item_options (group_id, name) values ($1, 'x')`, [ID.group2]), 'opção em grupo alheio')
      expectForbidden(await attempt(db, `insert into merchant_hours (merchant_id, weekday, opens_at, closes_at) values ($1, 2, '10:00', '11:00')`, [ID.shop2]), 'horário alheio')
      // e na própria loja funciona
      expect((await attempt(db, `insert into catalog_items (merchant_id, category_id, name, price_brl) values ($1, $2, 'Novo', 12.5)`, [ID.shop1, ID.cat1])).ok).toBe(true)
      expect((await attempt(db, `update catalog_items set price_brl = 21 where id = $1`, [ID.item1])).ok).toBe(true)
      expect((await attempt(db, `insert into item_options (group_id, name) values ($1, 'Queijo')`, [ID.group1])).ok).toBe(true)
    })

    test('merchant NÃO lê couriers, motoboys, frotas, posições nem a tabela de preço de entrega (isolamento financeiro)', async () => {
      for (const t of ['couriers', 'fleets', 'courier_positions', 'pricing_rules', 'audit_log']) {
        expect(await count(merchant1, t), t).toBe(0)
      }
      // perfis: só o dele (nenhum perfil de motoboy ou de dono de frota)
      expect(await readAs(db, merchant1, 'select id from profiles')).toEqual([ID.merchant1])
      await actAs(db, merchant1)
      expectForbidden(await attempt(db, `insert into couriers (profile_id, vehicle, base_city) values ($1, 'moto', 'quarai')`, [ID.merchant1]), 'insert couriers')
      expectRefused(await attempt(db, `update couriers set is_online = true where profile_id = $1`, [ID.courierQ1]), 'update couriers')
      expectRefused(await attempt(db, `update fleets set name = 'x' where id = $1`, [ID.fleet1]), 'update fleets')
    })

    test('merchant NÃO lê loja sem dono (owner_id nulo): nada vaza por comparação com NULL', async () => {
      // as duas lojas de exemplo do seed também são sem dono: o merchant não vê nenhuma delas
      const own = await readAs(db, merchant1, 'select id from merchants')
      expect(own).toEqual([ID.shop1])
      expect(own).not.toContain(ID.shopOrphan)
      expect(own).not.toContain('00000000-0000-4000-8000-000000000001')
      expect(own).not.toContain('00000000-0000-4000-8000-000000000002')
      expect(await readAs(db, merchant1, `select id from catalog_items where merchant_id = '${ID.shopOrphan}'`)).toEqual([])
      expect(await readAs(db, merchant1, `select id from merchant_hours where merchant_id = '${ID.shopOrphan}'`)).toEqual([])
      await actAs(db, merchant1)
      expectRefused(await attempt(db, `update merchants set name = 'minha agora' where id = $1`, [ID.shopOrphan]), 'update loja sem dono')
      expectForbidden(await attempt(db, `insert into catalog_items (merchant_id, name, price_brl) values ($1, 'x', 1)`, [ID.shopOrphan]), 'insert em loja sem dono')
      expectRefused(await attempt(db, `delete from catalog_items where id = $1`, [ID.itemOrphan]), 'delete em loja sem dono')
      expectRefused(await attempt(db, `update merchants set owner_id = $1 where id = $2`, [ID.merchant1, ID.shopOrphan]), 'tomar posse')
      const [m] = await asOwner<{ name: string; owner_id: string | null }>(db, `select name, owner_id from merchants where id = $1`, [ID.shopOrphan])
      expect(m).toEqual({ name: 'Loja sem dono', owner_id: null })
      // só o admin enxerga e edita
      const adminSees = await readAs(db, admin, 'select id from merchants')
      expect(adminSees).toEqual(expect.arrayContaining([ID.shopOrphan, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']))
      await actAs(db, admin)
      const up = await attempt(db, `update merchants set name = 'Loja admin' where id = $1`, [ID.shopOrphan])
      expect(up.ok && up.rowCount).toBe(1)
    })

    test('sessão autenticada SEM sub (uid nulo) não casa com owner_id nulo: não lê nem escreve nada', async () => {
      const noSub: Who = { uid: null }
      for (const t of ['merchants', 'catalog_items', 'orders', 'profiles', 'couriers', 'fleets', 'addresses']) {
        expect(await count(noSub, t), t).toBe(0)
      }
      await actAs(db, noSub)
      expectRefused(await attempt(db, `update merchants set name = 'x' where owner_id is null`), 'update em lojas sem dono')
      expectForbidden(await attempt(db, `insert into catalog_items (merchant_id, name, price_brl) values ($1, 'x', 1)`, [ID.shopOrphan]), 'insert')
      // um uid que não existe em profiles também fica sem papel
      const ghost: Who = { uid: 'a0000000-0000-4000-8000-0000000000ff' }
      for (const t of ['merchants', 'orders', 'settings']) {
        expect(await count(ghost, t, t === 'settings' ? 'not is_public' : 'true'), t).toBe(0)
      }
    })

    test('merchant não mexe em comissão, status nem dono da própria loja; edita o resto', async () => {
      await actAs(db, merchant1)
      for (const set of ['commission_pct = 0', "status = 'suspended'", `owner_id = '${ID.merchant2}'`, "city = 'artigas'", "kind = 'loja'"]) {
        expectForbidden(await attempt(db, `update merchants set ${set} where id = $1`, [ID.shop1]), set)
      }
      expect((await attempt(db, `update merchants set is_open_manual = false, prep_time_min = 30, name = 'Loja 1 B' where id = $1`, [ID.shop1])).ok).toBe(true)
      expectForbidden(await attempt(db, `insert into merchants (name, kind, city, country, owner_id) values ('nova', 'loja', 'quarai', 'BR', $1)`, [ID.merchant1]), 'criar loja')
      expectRefused(await attempt(db, `delete from merchants where id = $1`, [ID.shop1]), 'apagar loja')
      const [m] = await asOwner<{ commission_pct: string }>(db, `select commission_pct from merchants where id = $1`, [ID.shop1])
      expect(m.commission_pct).toBe('12.50')
    })
  })

  // -------------------------------------------------------------------- fleet
  describe('fleet', () => {
    test('fleet lê pedidos atendidos pela própria frota', async () => {
      expect(await orderIds(fleet1)).toEqual([ID.oFleet1])
      expect(await orderIds(fleet2)).toEqual([]) // oQueueA é fila, sem frota
      await asOwner(db, `update orders set fleet_id = $1 where id = $2`, [ID.fleet2, ID.oQueueA])
      expect(await orderIds(fleet2)).toEqual([ID.oQueueA])
      expect(await orderIds(fleet1)).toEqual([ID.oFleet1])
    })

    test('fleet NÃO lê faturamento nem catalog_items de merchant (isolamento financeiro)', async () => {
      for (const t of [
        'merchants', 'merchant_hours', 'catalog_categories', 'catalog_items', 'item_option_groups', 'item_options',
        'order_items', // itens vendidos = faturamento da loja, mesmo nos pedidos que a frota entregou
        'audit_log',
      ]) {
        expect(await count(fleet1, t), t).toBe(0)
      }
      // o pedido que a frota entregou está visível, mas sem as linhas de itens
      expect(await orderIds(fleet1)).toContain(ID.oFleet1)
      await actAs(db, fleet1)
      expectRefused(await attempt(db, `update merchants set commission_pct = 0 where id = $1`, [ID.shop1]), 'update merchants')
      expectRefused(await attempt(db, `update catalog_items set price_brl = 0.01 where id = $1`, [ID.item1]), 'update catalog')
      expectForbidden(await attempt(db, `insert into catalog_items (merchant_id, name, price_brl) values ($1, 'x', 1)`, [ID.shop1]), 'insert catalog')
    })

    test('fleet lê só os próprios couriers e seus perfis; não os de outra frota nem autônomos', async () => {
      expect(await readAs(db, fleet1, 'select profile_id from couriers', 'profile_id')).toEqual([ID.courierQ1])
      expect(await readAs(db, fleet2, 'select profile_id from couriers', 'profile_id')).toEqual([ID.courierA1])
      expect(await readAs(db, fleet1, 'select id from profiles')).toEqual(sorted(ID.fleetOwner1, ID.courierQ1))
      expect(await readAs(db, fleet1, 'select id from fleets')).toEqual([ID.fleet1])
    })

    test('fleet gerencia escala dos próprios couriers, mas não status, frota nem couriers alheios', async () => {
      await actAs(db, fleet1)
      expect((await attempt(db, `update couriers set is_online = true where profile_id = $1`, [ID.courierQ1])).ok).toBe(true)
      expectRefused(await attempt(db, `update couriers set is_online = true where profile_id = $1`, [ID.courierQ2]), 'autônomo')
      expectRefused(await attempt(db, `update couriers set is_online = true where profile_id = $1`, [ID.courierA1]), 'outra frota')
      expectForbidden(await attempt(db, `update couriers set status = 'suspended' where profile_id = $1`, [ID.courierQ1]), 'status')
      expectForbidden(await attempt(db, `update couriers set fleet_id = $1 where profile_id = $2`, [ID.fleet2, ID.courierQ1]), 'mover para outra frota')
      expectRefused(await attempt(db, `update couriers set fleet_id = $1 where profile_id = $2`, [ID.fleet1, ID.courierQ2]), 'roubar autônomo')
      expectForbidden(await attempt(db, `insert into couriers (profile_id, vehicle, base_city, fleet_id) values ($1, 'moto', 'quarai', $2)`, [ID.clientA, ID.fleet1]), 'cadastrar courier')
      expect((await attempt(db, `update fleets set name = 'Tele Quarai 2' where id = $1`, [ID.fleet1])).ok).toBe(true)
      expectForbidden(await attempt(db, `update fleets set status = 'pending' where id = $1`, [ID.fleet1]), 'fleets.status')
      expectForbidden(await attempt(db, `update fleets set owner_id = $1 where id = $2`, [ID.fleetOwner2, ID.fleet1]), 'fleets.owner_id')
      expectRefused(await attempt(db, `update fleets set name = 'x' where id = $1`, [ID.fleet2]), 'frota alheia')
    })

    test('frota suspensa não lê pedidos nem couriers (mas vê o próprio cadastro)', async () => {
      await asOwner(db, `update fleets set status = 'suspended' where id = $1`, [ID.fleet1])
      expect(await orderIds(fleet1)).toEqual([])
      expect(await readAs(db, fleet1, 'select profile_id from couriers', 'profile_id')).toEqual([])
      expect(await readAs(db, fleet1, 'select id from fleets')).toEqual([ID.fleet1])
    })
  })

  // -------------------------------------------------------------------- admin
  describe('admin', () => {
    test('admin lê tudo: pedidos, lojas (inclusive sem dono), perfis, auditoria', async () => {
      const [{ n: ordersTotal }] = await asOwner<{ n: number }>(db, `select count(*)::int n from orders`)
      expect(await count(admin, 'orders')).toBe(ordersTotal)
      const [{ n: profilesTotal }] = await asOwner<{ n: number }>(db, `select count(*)::int n from profiles`)
      expect(await count(admin, 'profiles')).toBe(profilesTotal)
      const [{ n: merchantsTotal }] = await asOwner<{ n: number }>(db, `select count(*)::int n from merchants`)
      expect(await count(admin, 'merchants')).toBe(merchantsTotal)
      expect(await count(admin, 'audit_log')).toBeGreaterThan(0)
    })

    test('admin altera dinheiro do pedido (único papel que pode) e aprova lojas e frotas', async () => {
      await actAs(db, admin)
      const a = await attempt(db, `update orders set total_brl = 26.00, pricing_breakdown = '{"fix": true}' where id = $1`, [ID.oQueueQ])
      expect(a.ok && a.rowCount).toBe(1)
      expect((await attempt(db, `update merchants set status = 'suspended', commission_pct = 11 where id = $1`, [ID.shop1])).ok).toBe(true)
      expect((await attempt(db, `update couriers set status = 'suspended' where profile_id = $1`, [ID.courierQ1])).ok).toBe(true)
      expect((await attempt(db, `update profiles set role = 'merchant' where id = $1`, [ID.clientB])).ok).toBe(true)
      expect((await attempt(db, `insert into zones (city, name) values ('artigas', 'Nova')`)).ok).toBe(true)
    })

    test('admin com perfil bloqueado perde todo o poder (papel sai de profiles.status)', async () => {
      const blocked: Who = { uid: ID.blockedAdmin }
      await actAs(db, blocked)
      expect((await db.query('select public.is_admin() a, public.current_role() r')).rows[0]).toEqual({ a: false, r: null })
      expect(await count(blocked, 'merchants')).toBe(0)
      expect(await count(blocked, 'audit_log')).toBe(0)
      expect(await readAs(db, blocked, 'select id from profiles')).toEqual([ID.blockedAdmin]) // só o próprio
      await actAs(db, blocked)
      expectRefused(await attempt(db, `update pricing_rules set base_fare_brl = 99`), 'pricing_rules')
    })

    test('cliente bloqueado não lê os próprios pedidos', async () => {
      await asOwner(db, `update profiles set status = 'blocked' where id = $1`, [ID.clientA])
      expect(await orderIds(clientA)).toEqual([])
      expect(await readAs(db, clientA, 'select id from profiles')).toEqual([ID.clientA])
    })
  })

  // --------------------------------------------------------------------- anon
  describe('anon', () => {
    test('anon lê settings com is_public true e NÃO as demais', async () => {
      const expected = (await asOwner<{ key: string }>(db, `select key from settings where is_public order by 1`)).map((r) => r.key)
      expect(expected.length).toBeGreaterThan(0)
      expect(await readAs(db, 'anon', 'select key from settings', 'key')).toEqual(expected)
      expect(await readAs(db, 'anon', `select key from settings where key = 'rls_fixture_private'`, 'key')).toEqual([])
      expect(await readAs(db, 'anon', `select key from settings where not is_public`, 'key')).toEqual([])
    })

    test('anon NÃO lê profiles (sem privilégio, e mesmo com o privilégio devolvido a RLS devolve zero)', async () => {
      await actAs(db, 'anon')
      expectForbidden(await attempt(db, 'select id from profiles'), 'sem privilégio')
      await asOwner(db, 'grant select on public.profiles, public.orders, public.audit_log to anon') // revertido pelo rollback
      expect(await count('anon', 'profiles')).toBe(0)
      expect(await count('anon', 'orders')).toBe(0)
      expect(await count('anon', 'audit_log')).toBe(0)
    })

    test('anon não escreve em nada, nem em settings', async () => {
      await actAs(db, 'anon')
      expectForbidden(await attempt(db, `insert into settings (key, value, is_public) values ('x', '1', true)`), 'insert settings')
      expectForbidden(await attempt(db, `update settings set value = '"hack"' where is_public`), 'update settings')
      expectForbidden(await attempt(db, `delete from settings`), 'delete settings')
      expectForbidden(await attempt(db, `insert into profiles (id, role) values (gen_random_uuid(), 'admin')`), 'insert profiles')
      expectForbidden(await attempt(db, `update pricing_rules set base_fare_brl = 0`), 'pricing_rules')
      // com os privilégios devolvidos, as policies sozinhas ainda recusam
      await asOwner(db, 'grant insert, update, delete on public.settings, public.pricing_rules, public.profiles to anon')
      await actAs(db, 'anon')
      expectForbidden(await attempt(db, `insert into settings (key, value, is_public) values ('x', '1', true)`), 'insert settings (RLS)')
      expectRefused(await attempt(db, `update settings set value = '"hack"'`), 'update settings (RLS)')
      expectRefused(await attempt(db, `delete from settings`), 'delete settings (RLS)')
      expectForbidden(await attempt(db, `insert into profiles (id, role) values (gen_random_uuid(), 'admin')`), 'insert profiles (RLS)')
      expectRefused(await attempt(db, `update pricing_rules set base_fare_brl = 0`), 'pricing_rules (RLS)')
    })

    test('authenticated lê só settings públicas; as demais só o admin, que também escreve', async () => {
      const pub = (await asOwner<{ key: string }>(db, `select key from settings where is_public order by 1`)).map((r) => r.key)
      for (const w of [clientA, courierQ1, merchant1, fleet1]) {
        expect(await readAs(db, w, 'select key from settings', 'key')).toEqual(pub)
        await actAs(db, w)
        expectRefused(await attempt(db, `update settings set value = '"x"'`), 'update')
        expectForbidden(await attempt(db, `insert into settings (key, value) values ('k', '1')`), 'insert')
        expectRefused(await attempt(db, `delete from settings`), 'delete')
      }
      const all = await readAs(db, admin, 'select key from settings', 'key')
      expect(all).toContain('rls_fixture_private')
      await actAs(db, admin)
      expect((await attempt(db, `update settings set value = '"novo"' where key = 'rls_fixture_private'`)).ok).toBe(true)
    })
  })

  // ------------------------------------------------- preço, câmbio, zonas, transições
  describe('preço, câmbio e configuração', () => {
    const writers: [string, Who][] = [
      ['anon', 'anon'], ['client', clientA], ['courier', courierQ1], ['merchant', merchant1], ['fleet', fleet1],
      ['admin bloqueado', { uid: ID.blockedAdmin }], ['courier pendente', { uid: ID.pendingCourier }],
    ]

    test('ninguém além de admin escreve em pricing_rules ou fx_rates', async () => {
      const snap = async () =>
        (await asOwner<{ h: string }>(db, `select md5((select string_agg(p::text, '|' order by p.id) from pricing_rules p) || (select string_agg(f::text, '|' order by f.id) from fx_rates f)) h`))[0].h
      const before = await snap()
      for (const [name, w] of writers) {
        await actAs(db, w)
        expectRefused(await attempt(db, `update pricing_rules set base_fare_brl = 99, per_km_brl = 99`), `${name} update pricing_rules`)
        expectRefused(await attempt(db, `delete from pricing_rules`), `${name} delete pricing_rules`)
        expectForbidden(
          await attempt(db, `insert into pricing_rules (city, kind, base_fare_brl, included_km, per_km_brl, min_fare_brl, valid_from) values ('quarai', 'ride', 1, 1, 1, 1, '2031-01-01')`),
          `${name} insert pricing_rules`,
        )
        expectRefused(await attempt(db, `update fx_rates set rate = 1`), `${name} update fx_rates`)
        expectRefused(await attempt(db, `delete from fx_rates`), `${name} delete fx_rates`)
        expectForbidden(await attempt(db, `insert into fx_rates (rate, source) values (1, 'manual')`), `${name} insert fx_rates`)
      }
      expect(await snap()).toBe(before)
      // o admin escreve (transação revertida no fim)
      await actAs(db, admin)
      const up = await attempt(db, `update pricing_rules set night_surcharge_brl = 4 where city = 'quarai' and kind = 'food' and valid_to is null`)
      expect(up.ok && up.rowCount).toBe(1)
      expect((await attempt(db, `insert into fx_rates (rate, source) values (7.9, 'manual')`)).ok).toBe(true)
      expect((await attempt(db, `update fx_rates set rate = 8 where id = $1`, [ID.fx1])).ok).toBe(true)
    })

    test('zonas e transições: autenticado lê, só admin escreve', async () => {
      for (const t of ['zones', 'status_transitions']) {
        for (const [name, w] of writers.filter(([n]) => n !== 'anon' && n !== 'admin bloqueado' && n !== 'courier pendente')) {
          expect(await count(w, t), `${name} lê ${t}`).toBeGreaterThan(0)
          await actAs(db, w)
          expectRefused(await attempt(db, `delete from ${t}`), `${name} delete ${t}`)
        }
      }
      for (const [name, w] of writers) {
        await actAs(db, w)
        expectForbidden(await attempt(db, `insert into zones (city, name) values ('quarai', 'x')`), `${name} insert zones`)
        expectRefused(await attempt(db, `update zones set is_served = false`), `${name} update zones`)
        expectForbidden(
          await attempt(db, `insert into status_transitions (kind, from_status, to_status, allowed_role) values ('food', 'criado', 'entregue', 'client')`),
          `${name} insert status_transitions`,
        )
      }
      await actAs(db, admin)
      expect((await attempt(db, `update zones set is_served = false where name like 'Centro%'`)).ok).toBe(true)
    })
  })

  // ---------------------------------------------- papel vem de profiles, não do JWT
  describe('papel vem de profiles, não do JWT', () => {
    const forged = {
      role: 'authenticated',
      user_role: 'admin',
      app_metadata: { role: 'admin', provider: 'email' },
      user_metadata: { role: 'admin' },
      is_admin: true,
    }

    test('papel vem de profiles, não de JWT: claim role forjado é ignorado', async () => {
      const forger: Who = { uid: ID.clientA, claims: forged }
      await actAs(db, forger)
      expect((await db.query('select public.current_role() r, public.is_admin() a')).rows[0]).toEqual({ r: 'client', a: false })
      // nenhum poder de admin
      expect(await count(forger, 'audit_log')).toBe(0)
      expect(await readAs(db, forger, 'select id from profiles')).toEqual([ID.clientA])
      expect(await orderIds(forger)).toEqual(sorted(ID.oQueueQ, ID.oTakenQ2, ID.oFleet1))
      await actAs(db, forger)
      expectRefused(await attempt(db, `update pricing_rules set base_fare_brl = 0.01`), 'pricing_rules')
      expectForbidden(await attempt(db, `update orders set total_brl = 0.01 where id = $1`, [ID.oQueueQ]), 'total_brl')
      expectForbidden(await attempt(db, `update profiles set role = 'admin' where id = $1`, [ID.clientA]), 'auto-promoção')
      expectRefused(await attempt(db, `update merchants set status = 'suspended'`), 'merchants')
    })

    test('um claim forjado de service_role ou de outro sub também não muda nada; o que vale é o sub e o profiles', async () => {
      const f2: Who = { uid: ID.clientA, claims: { ...forged, role: 'service_role', sub_role: 'admin' } }
      await actAs(db, f2)
      expect((await db.query('select public.current_role() r')).rows[0].r).toBe('client')
      expect(await count(f2, 'audit_log')).toBe(0)
      // controle positivo: o MESMO token passa a valer como admin quando o banco (e só o banco) promove o perfil
      await asOwner(db, `update profiles set role = 'admin' where id = $1`, [ID.clientA])
      await actAs(db, { uid: ID.clientA })
      expect((await db.query('select public.is_admin() a')).rows[0].a).toBe(true)
      expect(await count({ uid: ID.clientA }, 'audit_log')).toBeGreaterThan(0)
    })
  })

  // ---------------------------------------------------------------- auditoria
  describe('auditoria', () => {
    test('escrita de admin em pricing_rules grava audit_log com before e after', async () => {
      await actAs(db, admin)
      const up = await attempt(db, `update pricing_rules set night_surcharge_brl = 4.00 where city = 'quarai' and kind = 'food' and valid_to is null returning id`)
      expect(up.ok && up.rowCount).toBe(1)
      const id = ((up as unknown) as { rows: { id: string }[] }).rows[0].id
      const log = await asOwner<{ actor_id: string; actor_role: string; action: string; record_id: string; before: Record<string, string>; after: Record<string, string> }>(
        db, `select * from audit_log where table_name = 'pricing_rules' and record_id = $1`, [id])
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({ actor_id: ID.admin, actor_role: 'admin', action: 'UPDATE', record_id: id })
      expect(Number(log[0].before.night_surcharge_brl)).toBe(3)
      expect(Number(log[0].after.night_surcharge_brl)).toBe(4)
      expect(log[0].before.id).toBe(id)
      // o admin consegue ler a própria trilha
      await actAs(db, admin)
      expect((await db.query(`select count(*)::int n from audit_log where table_name = 'pricing_rules'`)).rows[0].n).toBeGreaterThan(0)
    })

    test('escrita de merchant em catalog_items grava audit_log com ator e papel (insert, update e delete)', async () => {
      await actAs(db, merchant1)
      const ins = await attempt(db, `insert into catalog_items (merchant_id, name, price_brl) values ($1, 'Auditado', 10) returning id`, [ID.shop1])
      const id = ((ins as unknown) as { rows: { id: string }[] }).rows[0].id
      expect((await attempt(db, `update catalog_items set price_brl = 11 where id = $1`, [id])).ok).toBe(true)
      expect((await attempt(db, `delete from catalog_items where id = $1`, [id])).ok).toBe(true)
      const log = await asOwner<{ actor_id: string; actor_role: string; action: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(
        db, `select * from audit_log where table_name = 'catalog_items' and record_id = $1 order by id`, [id])
      expect(log.map((l) => l.action)).toEqual(['INSERT', 'UPDATE', 'DELETE'])
      for (const l of log) expect(l).toMatchObject({ actor_id: ID.merchant1, actor_role: 'merchant' })
      expect(log[0].before).toBeNull()
      expect(Number((log[0].after as { price_brl: string }).price_brl)).toBe(10)
      expect(Number((log[1].before as { price_brl: string }).price_brl)).toBe(10)
      expect(Number((log[1].after as { price_brl: string }).price_brl)).toBe(11)
      expect(log[2].after).toBeNull()
      // o merchant não lê a trilha (nem a própria)
      expect(await count(merchant1, 'audit_log')).toBe(0)
    })

    test('as nove tabelas sensíveis têm o trigger e as demais não', async () => {
      const r = await asOwner<{ relname: string }>(
        db,
        `select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
         where not t.tgisinternal and t.tgfoid = 'public.audit_write'::regproc order by 1`,
      )
      expect(r.map((x) => x.relname)).toEqual(
        ['catalog_categories', 'catalog_items', 'couriers', 'fx_rates', 'merchants', 'pricing_rules', 'profiles', 'settings', 'zones'],
      )
    })

    test('mudança de role em profiles e escrita em settings/couriers/zones/merchants/fx_rates ficam registradas com o ator', async () => {
      await actAs(db, admin)
      expect((await attempt(db, `update profiles set role = 'merchant' where id = $1`, [ID.clientB])).ok).toBe(true)
      expect((await attempt(db, `update settings set value = '"novo"' where key = 'rls_fixture_private'`)).ok).toBe(true)
      expect((await attempt(db, `update couriers set status = 'suspended' where profile_id = $1`, [ID.courierQ1])).ok).toBe(true)
      expect((await attempt(db, `update zones set is_served = false where name like 'Centro%'`)).ok).toBe(true)
      expect((await attempt(db, `update merchants set commission_pct = 20 where id = $1`, [ID.shop1])).ok).toBe(true)
      expect((await attempt(db, `update fx_rates set rate = 8.1 where id = $1`, [ID.fx1])).ok).toBe(true)
      const r = await asOwner<{ table_name: string; record_id: string; before: Record<string, unknown>; after: Record<string, unknown> }>(
        db, `select table_name, record_id, before, after from audit_log where actor_id = $1 and action = 'UPDATE' order by id`, [ID.admin])
      expect(r.map((x) => x.table_name)).toEqual(['profiles', 'settings', 'couriers', 'zones', 'merchants', 'fx_rates'])
      expect(r.map((x) => x.record_id)).toEqual([ID.clientB, 'rls_fixture_private', ID.courierQ1, expect.any(String), ID.shop1, ID.fx1])
      expect(r[0].before.role).toBe('client')
      expect(r[0].after.role).toBe('merchant')
    })

    test('audit_log não é alterável nem apagável por nenhum papel, inclusive admin', async () => {
      const logged = await asOwner<{ id: string }>(db, `select id::text from audit_log order by id limit 1`)
      expect(logged.length).toBe(1)
      const snapshot = async () => (await asOwner<{ h: string; n: number }>(db, `select md5(string_agg(a::text, '|' order by a.id)) h, count(*)::int n from audit_log a`))[0]
      const before = await snapshot()
      for (const [name, w] of [
        ['admin', admin], ['client', clientA], ['courier', courierQ1], ['merchant', merchant1], ['fleet', fleet1], ['anon', 'anon' as Who],
      ] as [string, Who][]) {
        await actAs(db, w)
        expectForbidden(await attempt(db, `update audit_log set action = 'adulterado'`), `${name} update`)
        expectForbidden(await attempt(db, `delete from audit_log`), `${name} delete`)
        expectForbidden(await attempt(db, `insert into audit_log (table_name, action) values ('x', 'INSERT')`), `${name} insert`)
        expectForbidden(await attempt(db, `truncate audit_log`), `${name} truncate`)
      }
      expect(await snapshot()).toEqual(before)
    })

    test('audit_log: mesmo com os privilégios devolvidos, a RLS não deixa nenhum papel inserir, alterar ou apagar', async () => {
      await asOwner(db, 'grant insert, update, delete on public.audit_log to authenticated') // revertido pelo rollback
      const pol = await asOwner<{ cmd: string; policyname: string }>(db, `select cmd, policyname from pg_policies where schemaname = 'public' and tablename = 'audit_log'`)
      expect(pol.map((p) => p.cmd)).toEqual(['SELECT']) // a única policy é o select do admin
      const before = (await asOwner<{ n: number }>(db, `select count(*)::int n from audit_log`))[0].n
      for (const w of [admin, clientA, merchant1, fleet1, courierQ1]) {
        await actAs(db, w)
        expectRefused(await attempt(db, `update audit_log set action = 'adulterado'`), 'update')
        expectRefused(await attempt(db, `delete from audit_log`), 'delete')
        expectForbidden(await attempt(db, `insert into audit_log (table_name, action) values ('x', 'INSERT')`), 'insert')
      }
      expect((await asOwner<{ n: number }>(db, `select count(*)::int n from audit_log`))[0].n).toBe(before)
      expect((await asOwner(db, `select 1 from audit_log where action = 'adulterado' or table_name = 'x'`)).length).toBe(0)
    })
  })

  // ----------------------------------------- defesa em profundidade: o trigger sozinho
  describe('trigger de colunas independente da policy', () => {
    test('mesmo se uma policy de UPDATE frouxa fosse criada por engano, o trigger recusa dinheiro e role', async () => {
      // DDL dentro da transação: some no rollback
      await asOwner(db, `create policy tmp_oops on public.orders for update to authenticated using (true) with check (true)`)
      await asOwner(db, `create policy tmp_oops on public.profiles for update to authenticated using (true) with check (true)`)
      await asOwner(db, `create policy tmp_oops on public.merchants for update to authenticated using (true) with check (true)`)
      for (const w of [merchant1, courierQ1, fleet1]) {
        await actAs(db, w)
        for (const set of ['total_brl = 0.01', "pricing_breakdown = '{}'::jsonb", 'fx_rate_used = 1', "status = 'entregue'"]) {
          expectForbidden(await attempt(db, `update orders set ${set} where id = $1`, [ID.oFleet1]), set)
        }
        expectForbidden(await attempt(db, `update profiles set role = 'admin' where id = $1`, [(w as { uid: string }).uid]), 'role')
      }
      await actAs(db, merchant1)
      expectForbidden(await attempt(db, `update merchants set commission_pct = 0 where id = $1`, [ID.shop1]), 'commission_pct')
      const [o] = await asOwner<{ total_brl: string; status: string }>(db, `select total_brl, status from orders where id = $1`, [ID.oFleet1])
      expect(o).toEqual({ total_brl: '50.00', status: 'coletado' })
      // e o admin continua podendo
      await actAs(db, admin)
      expect((await attempt(db, `update orders set total_brl = 51.00 where id = $1`, [ID.oFleet1])).ok).toBe(true)
    })

    test('o trigger não atrapalha caminhos de servidor: dono do banco e service_role escrevem dinheiro', async () => {
      const a = await attempt(db, `update orders set total_brl = 27.00 where id = $1`, [ID.oQueueQ])
      expect(a.ok && a.rowCount).toBe(1)
      await db.query('reset role')
      await db.query('set local role service_role')
      const b = await attempt(db, `update orders set total_brl = 28.00 where id = $1`, [ID.oQueueQ])
      expect(b.ok && b.rowCount).toBe(1)
    })
  })
})

// ===================================================================== E2E
// The tests above impersonate roles inside Postgres. This block proves the same policies hold in the
// real request path: Supabase Auth issues a real JWT, PostgREST validates it and switches the DB role.
// It COMMITS rows (a real auth user needs real rows), so everything it creates is deleted in afterAll
// and its leftovers are asserted gone.
describe('PostgREST ponta a ponta (JWT real, chave publicável)', () => {
  const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const PUB = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  const SECRET = process.env.SUPABASE_SECRET_KEY!
  const tag = `rls-e2e-${Date.now().toString(36)}`
  const created: { id: string; email: string; password: string; token?: string }[] = []
  const orderIds_: string[] = []
  let committer: Client
  let A: (typeof created)[number], C: (typeof created)[number], B: (typeof created)[number]
  let orderA: string, orderC: string
  let pricingBefore: string

  const decode = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())

  async function rest(path: string, token: string | null, init: { method?: string; body?: unknown; prefer?: string } = {}) {
    const res = await fetch(`${URL_}/rest/v1/${path}`, {
      method: init.method ?? 'GET',
      headers: {
        apikey: PUB,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
        ...(init.prefer ? { Prefer: init.prefer } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    const text = await res.text()
    return { status: res.status, json: text ? JSON.parse(text) : null }
  }
  async function signIn(u: { email: string; password: string }) {
    const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: PUB, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: u.email, password: u.password }),
    })
    const j = await res.json()
    if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${JSON.stringify(j).slice(0, 200)}`)
    return j.access_token as string
  }
  async function createUser(name: string) {
    const email = `${tag}-${name}@rls-e2e.invalid`
    const password = `Pw-${crypto.randomUUID()}`
    const res = await fetch(`${URL_}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, email_confirm: true }),
    })
    const j = await res.json()
    if (!res.ok) throw new Error(`createUser failed: ${res.status} ${JSON.stringify(j).slice(0, 200)}`)
    const u = { id: j.id as string, email, password }
    created.push(u)
    return u
  }

  async function cleanup() {
    // orders first (FK to profiles has no cascade), then the auth users (cascades to profiles),
    // then the audit rows those profile writes produced.
    const ids = created.map((u) => u.id)
    if (ids.length === 0) return
    await committer.query('delete from public.orders where client_id = any($1::uuid[])', [ids])
    for (const u of created) {
      await fetch(`${URL_}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}` } })
    }
    await committer.query(`delete from public.profiles where id = any($1::uuid[])`, [ids])
    await committer.query(`delete from public.audit_log where table_name = 'profiles' and record_id = any($1::text[])`, [ids])
  }

  beforeAll(async () => {
    expect(URL_ && PUB && SECRET, 'Supabase URL/keys must be in .env.local').toBeTruthy()
    committer = await connect()
    try {
      pricingBefore = (await committer.query(`select md5(string_agg(p::text, '|' order by p.id)) h from public.pricing_rules p`)).rows[0].h
      ;[A, C, B] = [await createUser('a'), await createUser('c'), await createUser('b')]
      await committer.query(
        `insert into public.profiles (id, role, full_name) values ($1, 'client', 'E2E A'), ($2, 'client', 'E2E C'), ($3, 'admin', 'E2E Admin')`,
        [A.id, C.id, B.id],
      )
      const ins = (client: string) =>
        committer.query(
          `insert into public.orders (kind, client_id, pickup_address, dropoff_address, total_brl, total_charged, payment_method, status)
           values ('courier', $1, '{"city":"quarai"}', '{"city":"quarai"}', 25.00, 25.00, 'pix', 'criado') returning id`,
          [client],
        )
      orderA = (await ins(A.id)).rows[0].id
      orderC = (await ins(C.id)).rows[0].id
      orderIds_.push(orderA, orderC)
      for (const u of [A, C, B]) u.token = await signIn(u)
    } catch (e) {
      await cleanup()
      await committer.end()
      throw e
    }
  })
  afterAll(async () => {
    try {
      await cleanup()
      const left = await committer.query(
        `select (select count(*)::int from public.profiles where id = any($1::uuid[])) p,
                (select count(*)::int from public.orders where id = any($2::uuid[])) o,
                (select count(*)::int from public.audit_log where table_name = 'profiles' and record_id = any($3::text[])) a,
                (select count(*)::int from auth.users where id = any($1::uuid[])) u`,
        [created.map((u) => u.id), orderIds_, created.map((u) => u.id)],
      )
      expect(left.rows[0]).toEqual({ p: 0, o: 0, a: 0, u: 0 })
      const h = (await committer.query(`select md5(string_agg(p::text, '|' order by p.id)) h from public.pricing_rules p`)).rows[0].h
      expect(h).toBe(pricingBefore)
    } finally {
      await committer.end()
    }
  })

  test('anon (só a chave publicável): lê settings públicas, não lê profiles nem pedidos', async () => {
    const s = await rest('settings?select=key,is_public', null)
    expect(s.status).toBe(200)
    expect(s.json.length).toBeGreaterThan(0)
    expect(s.json.every((r: { is_public: boolean }) => r.is_public)).toBe(true)
    const p = await rest('profiles?select=id', null)
    expect(p.status).toBeGreaterThanOrEqual(400) // 42501: sem privilégio nenhum
    expect(JSON.stringify(p.json)).not.toContain(A.id)
    const o = await rest('orders?select=id', null)
    expect(o.status).toBeGreaterThanOrEqual(400)
  })

  test('client autenticado: lê só o próprio perfil e pedido; total_brl e role são recusados com 403', async () => {
    const prof = await rest('profiles?select=id,role', A.token!)
    expect(prof.status).toBe(200)
    expect(prof.json).toEqual([{ id: A.id, role: 'client' }])
    const ord = await rest('orders?select=id', A.token!)
    expect(ord.json).toEqual([{ id: orderA }])
    expect((await rest(`orders?id=eq.${orderC}&select=id`, A.token!)).json).toEqual([])
    const money = await rest(`orders?id=eq.${orderA}`, A.token!, { method: 'PATCH', body: { total_brl: 0.01 } })
    expect(money.status).toBe(403)
    expect(money.json.code).toBe('42501')
    const role = await rest(`profiles?id=eq.${A.id}`, A.token!, { method: 'PATCH', body: { role: 'admin' } })
    expect(role.status).toBe(403)
    const other = await rest(`orders?id=eq.${orderC}`, A.token!, { method: 'PATCH', body: { client_notes: 'x' }, prefer: 'return=representation' })
    expect(other.json).toEqual([])
    const audit = await rest('audit_log?select=id', A.token!)
    expect(audit.json).toEqual([])
    const ok = await rest(`orders?id=eq.${orderA}`, A.token!, { method: 'PATCH', body: { client_notes: 'sem cebola' }, prefer: 'return=representation' })
    expect(ok.status).toBe(200)
    expect(ok.json).toHaveLength(1)
    const [dbRow] = (await committer.query('select total_brl, client_notes from public.orders where id = $1', [orderA])).rows
    expect(dbRow).toEqual({ total_brl: '25.00', client_notes: 'sem cebola' })
  })

  test('JWT com user_metadata.role forjado como admin (editável pelo usuário) é ignorado de ponta a ponta', async () => {
    const put = await fetch(`${URL_}/auth/v1/user`, {
      method: 'PUT',
      headers: { apikey: PUB, Authorization: `Bearer ${C.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: { role: 'admin', user_role: 'admin' } }),
    })
    expect(put.status).toBe(200)
    const forgedToken = await signIn(C)
    const claims = decode(forgedToken)
    expect(claims.user_metadata.role).toBe('admin') // a forja chegou ao token...
    expect(claims.role).toBe('authenticated')
    expect((await rest('audit_log?select=id', forgedToken)).json).toEqual([]) // ...e não vale nada
    expect((await rest('profiles?select=id', forgedToken)).json).toEqual([{ id: C.id }])
    expect((await rest('orders?select=id', forgedToken)).json).toEqual([{ id: orderC }])
    const pr = await rest('pricing_rules?city=eq.quarai', forgedToken, { method: 'PATCH', body: { base_fare_brl: 0.01 }, prefer: 'return=representation' })
    expect(pr.json).toEqual([])
    const ins = await rest('pricing_rules', forgedToken, {
      method: 'POST',
      body: { city: 'quarai', kind: 'ride', base_fare_brl: 1, included_km: 1, per_km_brl: 1, min_fare_brl: 1, valid_from: '2031-01-01' },
    })
    expect(ins.status).toBe(403)
    const prom = await rest(`profiles?id=eq.${C.id}`, forgedToken, { method: 'PATCH', body: { role: 'admin' } })
    expect(prom.status).toBe(403)
  })

  test('admin real (profiles.role = admin) lê a trilha de auditoria e os pedidos de todos', async () => {
    const audit = await rest(`audit_log?select=table_name,action,record_id&table_name=eq.profiles&record_id=eq.${A.id}`, B.token!)
    expect(audit.status).toBe(200)
    expect(audit.json.length).toBeGreaterThan(0)
    const ords = await rest(`orders?select=id&id=in.(${orderA},${orderC})`, B.token!)
    expect(ords.json.map((r: { id: string }) => r.id).sort()).toEqual(sorted(orderA, orderC))
    const profs = await rest(`profiles?select=id&id=in.(${A.id},${C.id},${B.id})`, B.token!)
    expect(profs.json).toHaveLength(3)
  })
})
