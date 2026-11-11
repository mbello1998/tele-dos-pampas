import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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

const courierOrderIds = (who: Who) =>
  readAs(db, who, `select id from courier_orders where id in (${FIXTURE_ORDERS.map((i) => `'${i}'`).join(',')})`)

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
         where n.nspname = 'public' and p.proname in ('app_role', 'is_admin', 'audit_write')`,
      )
      expect(r.map((x) => x.proname).sort()).toEqual(['app_role', 'audit_write', 'is_admin'])
      for (const f of r) {
        expect(f.prosecdef, f.proname).toBe(true)
        expect((f.proconfig ?? []).join(','), f.proname).toMatch(/search_path=""|search_path=''/)
      }
      expect(r.find((x) => x.proname === 'app_role')!.rt).toBe('user_role')
      expect(r.find((x) => x.proname === 'is_admin')!.rt).toBe('boolean')
    })

    test('a função current_role() não existe mais e nenhum corpo de função ou policy menciona o nome', async () => {
      const f = await asOwner(
        db,
        `select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'private') and (p.proname = 'current_role' or p.prosrc ~* 'current_role')`,
      )
      expect(f).toEqual([])
      const pol = await asOwner(
        db,
        `select policyname from pg_policies where schemaname = 'public'
         and regexp_replace(coalesce(qual, '') || coalesce(with_check, ''), 'AS "current_role"', '', 'g') ~* 'current_role'`,
      )
      expect(pol).toEqual([])
    })

    test('nenhuma policy usa a palavra-chave current_role (devolveria o papel do Postgres, sempre diferente de admin)', async () => {
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
      ['merchants', 'true', ['merchant', 'admin']], // clients read merchants_public, never the base table
      ['merchants_public', 'true', ['client']],
      ['fleet_orders', 'true', ['fleet']],
      ['merchant_hours', 'true', ['client', 'merchant', 'admin']],
      ['catalog_categories', 'true', ['client', 'merchant', 'admin']],
      ['catalog_items', 'true', ['client', 'merchant', 'admin']],
      ['item_option_groups', 'true', ['client', 'merchant', 'admin']],
      ['item_options', 'true', ['client', 'merchant', 'admin']],
      ['couriers', 'true', ['courier', 'fleet', 'admin']],
      ['fleets', 'true', ['fleet', 'admin']],
      ['addresses', 'true', ['client', 'admin']],
      ['zones', 'true', ['client', 'courier', 'merchant', 'fleet', 'admin']],
      ['orders', 'true', ['client', 'merchant', 'admin']], // fleet reads fleet_orders and courier reads courier_orders, never orders
      ['courier_orders', 'true', ['courier']],
      ['order_commissions', 'true', ['merchant', 'admin']], // never client, courier or fleet
      ['order_items', 'true', ['client', 'merchant', 'admin']], // never fleet, never courier (unit prices = the shop's revenue)
      ['order_events', 'true', ['client', 'courier', 'merchant', 'fleet', 'admin']],
      ['courier_positions', 'true', ['client', 'courier', 'fleet', 'admin']], // client: own order's courier while active (0025); fleet: its couriers, last 15 min; never merchant or anon
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

    test('client lê lojas aprovadas só pela view merchants_public (sem comissão) e o cardápio delas, mas não loja pendente; não escreve no cardápio', async () => {
      const shops = await readAs(db, clientA, 'select id from merchants_public')
      expect(shops).toEqual(expect.arrayContaining([ID.shop1, ID.shop2, ID.shopOrphan]))
      expect(shops).not.toContain(ID.shopPending)
      // a tabela base é inacessível ao client; a view não tem a coluna de comissão nem de status/dono
      expect(await readAs(db, clientA, 'select id from merchants')).toEqual([])
      expect(await count(clientA, 'merchants', 'commission_pct > 0')).toBe(0)
      const cols = await asOwner<{ column_name: string }>(
        db, `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'merchants_public'`)
      for (const c of ['commission_pct', 'status', 'owner_id']) expect(cols.map((x) => x.column_name)).not.toContain(c)
      await actAs(db, clientA)
      const peek = await attempt(db, 'select commission_pct from merchants_public')
      expect(!peek.ok && peek.code).toBe('42703') // undefined_column
      const items = await readAs(db, clientA, 'select id from catalog_items')
      expect(items).toEqual(expect.arrayContaining([ID.item1, ID.item2, ID.itemOrphan]))
      expect(items).not.toContain(ID.itemPending)
      await actAs(db, clientA)
      expectForbidden(await attempt(db, `insert into catalog_items (merchant_id, name, price_brl) values ($1, 'x', 1)`, [ID.shop1]), 'insert item')
      expectRefused(await attempt(db, `update catalog_items set price_brl = 0.01 where id = $1`, [ID.item1]), 'update item')
      expectRefused(await attempt(db, `update merchants set status = 'approved', commission_pct = 0 where id = $1`, [ID.shop1]), 'update loja')
      // a view é somente leitura: nenhum papel escreve por ela
      expectForbidden(await attempt(db, `update merchants_public set name = 'x'`), 'update view')
      expectForbidden(await attempt(db, `delete from merchants_public`), 'delete view')
    })

    test('merchants_public: só client lê; fleet, courier, merchant, admin e anon recebem zero linhas ou erro', async () => {
      for (const w of [courierQ1, merchant1, fleet1, admin, { uid: ID.pendingCourier }]) {
        expect(await count(w, 'merchants_public'), JSON.stringify(w)).toBe(0)
      }
      await actAs(db, 'anon')
      expectForbidden(await attempt(db, 'select * from merchants_public'), 'anon')
      // loja suspensa some da vitrine
      await asOwner(db, `update merchants set status = 'suspended' where id = $1`, [ID.shop1])
      expect(await readAs(db, clientA, 'select id from merchants_public')).not.toContain(ID.shop1)
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

    test('client NÃO lê couriers, fleets nem audit_log; lê a posição do motoboy do próprio pedido só enquanto ele está ativo (0025)', async () => {
      for (const t of ['couriers', 'fleets', 'audit_log']) expect(await count(clientA, t), t).toBe(0)
      // permissão: oFleet1 (cliente A, motoboy Q1) está 'coletado', status ativo
      expect(await readAs(db, clientA, 'select courier_id from courier_positions', 'courier_id')).toEqual([ID.courierQ1])
      // negações: outro cliente, outra frota, merchant e pedido entregue
      expect(await count(clientB, 'courier_positions')).toBe(0)
      expect(await count(fleet2, 'courier_positions')).toBe(0)
      expect(await count(merchant1, 'courier_positions')).toBe(0)
      await asOwner(db, `update orders set status = 'entregue' where id = $1`, [ID.oFleet1])
      expect(await count(clientA, 'courier_positions')).toBe(0)
    })
  })

  // ------------------------------------------------------------------ courier
  describe('courier', () => {
    test('courier lê pedidos aguardando na cidade onde está habilitado, mais os que aceitou', async () => {
      expect(await courierOrderIds(courierQ1)).toEqual(sorted(ID.oQueueQ, ID.oFleet1)) // fila de Quarai + o dele
      expect(await courierOrderIds(courierQ2)).toEqual(sorted(ID.oQueueQ, ID.oTakenQ2))
    })

    test('courier NÃO lê pedido atribuído a outro courier', async () => {
      expect(await courierOrderIds(courierQ1)).not.toContain(ID.oTakenQ2)
      expect(await courierOrderIds(courierQ2)).not.toContain(ID.oFleet1)
      // nem mesmo se o pedido de outro courier estiver num status "de fila"
      await asOwner(db, `update orders set status = 'aguardando_motoboy' where id = $1`, [ID.oTakenQ2])
      expect(await courierOrderIds(courierQ1)).not.toContain(ID.oTakenQ2)
    })

    test('courier de outra cidade NÃO lê a fila de Quarai; pedido sem cidade não aparece para ninguém na fila', async () => {
      expect(await courierOrderIds(courierA1)).toEqual([ID.oQueueA])
      await asOwner(db, `update orders set pickup_address = '{}' where id = $1`, [ID.oQueueQ])
      expect(await courierOrderIds(courierQ1)).toEqual([ID.oFleet1])
    })

    test('courier com perfil pendente ou cadastro suspenso não lê nada', async () => {
      expect(await courierOrderIds({ uid: ID.pendingCourier })).toEqual([])
      await asOwner(db, `update couriers set status = 'suspended' where profile_id = $1`, [ID.courierQ1])
      expect(await courierOrderIds(courierQ1)).toEqual([])
    })

    test('courier não toma pedido por UPDATE direto (aceite é transição, não escrita) e não vê pedido em status que não é fila', async () => {
      await actAs(db, courierQ1)
      expectRefused(await attempt(db, `update orders set courier_id = $1, status = 'aceito' where id = $2`, [ID.courierQ1, ID.oQueueQ]), 'aceite direto')
      const [o] = await asOwner<{ courier_id: string | null; status: string }>(db, `select courier_id, status from orders where id = $1`, [ID.oQueueQ])
      expect(o).toEqual({ courier_id: null, status: 'aguardando_motoboy' })
      await asOwner(db, `update orders set status = 'entregue' where id = $1`, [ID.oQueueQ])
      expect(await courierOrderIds(courierQ1)).not.toContain(ID.oQueueQ)
    })

    test('courier NÃO lê comissão, subtotal de itens nem pricing_breakdown: courier_orders traz o valor a cobrar e nada mais', async () => {
      // 1. nem orders nem order_items: nenhuma linha, nem do pedido que ele carrega
      expect(await orderIds(courierQ1)).toEqual([])
      expect(await count(courierQ1, 'order_items')).toBe(0)
      // 2. a view não tem as colunas de dinheiro do pedido
      const cols = (await asOwner<{ column_name: string }>(
        db, `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'courier_orders'`)).map((c) => c.column_name)
      for (const c of ['total_brl', 'pricing_breakdown', 'fx_rate_used', 'fx_rate_id', 'pricing_rule_id', 'client_id', 'merchant_id']) expect(cols, c).not.toContain(c)
      for (const c of ['total_charged', 'currency_charged', 'change_for', 'payment_method', 'delivery_fee_brl']) expect(cols, c).toContain(c)
      await actAs(db, courierQ1)
      for (const col of ['total_brl', 'pricing_breakdown', 'fx_rate_used', 'merchant_id']) {
        const a = await attempt(db, `select ${col} from courier_orders`)
        expect(!a.ok && a.code, col).toBe('42703')
      }
      // 3. o valor a cobrar EXISTE no pedido que ele carrega (dinheiro, troco para 100)
      await asOwner(db, `update orders set payment_method = 'dinheiro_brl', change_for = 100.00 where id = $1`, [ID.oFleet1])
      await actAs(db, courierQ1)
      const row = (await db.query(`select * from courier_orders where id = $1`, [ID.oFleet1])).rows[0]
      expect(row).toMatchObject({ total_charged: '50.00', currency_charged: 'BRL', change_for: '100.00', payment_method: 'dinheiro_brl', delivery_fee_brl: '10.00' })
      expect(JSON.stringify(row)).not.toMatch(/items_subtotal|commission|breakdown/i)
      // 4. pedido ainda na fila: método de pagamento e taxa de entrega, mas ainda sem valores a cobrar
      const queued = (await db.query(`select * from courier_orders where id = $1`, [ID.oQueueQ])).rows[0]
      expect(queued).toMatchObject({ payment_method: 'pix', total_charged: null, change_for: null, currency_charged: null })
      // 5. só o courier que carrega o pedido vê o valor dele
      expect(await readAs(db, courierQ2, `select id from courier_orders where id = '${ID.oFleet1}'`)).toEqual([])
      // 6. a view é somente leitura e quem não é courier não lê
      await actAs(db, courierQ1)
      expectForbidden(await attempt(db, `update courier_orders set status = 'entregue'`), 'update view')
      expectForbidden(await attempt(db, `delete from courier_orders`), 'delete view')
      for (const w of [clientA, merchant1, fleet1, admin]) expect(await count(w, 'courier_orders'), JSON.stringify(w)).toBe(0)
      await actAs(db, 'anon')
      expectForbidden(await attempt(db, 'select * from courier_orders'), 'anon')
      // 7. a linha do tempo continua legível para o courier, só dos pedidos que ele enxerga
      expect(await readAs(db, courierQ1, 'select order_id from order_events', 'order_id')).toEqual([ID.oFleet1])
      expect(await readAs(db, courierQ2, 'select order_id from order_events', 'order_id')).toEqual([])
    })

    test('courier não altera status, frota nem cidade do próprio cadastro', async () => {
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
    test('fleet lê pedidos atendidos pela própria frota (pela view fleet_orders)', async () => {
      expect(await readAs(db, fleet1, 'select id from fleet_orders')).toEqual([ID.oFleet1])
      expect(await readAs(db, fleet2, 'select id from fleet_orders')).toEqual([]) // oQueueA é fila, sem frota
      await asOwner(db, `update orders set fleet_id = $1 where id = $2`, [ID.fleet2, ID.oQueueA])
      expect(await readAs(db, fleet2, 'select id from fleet_orders')).toEqual([ID.oQueueA])
      expect(await readAs(db, fleet1, 'select id from fleet_orders')).toEqual([ID.oFleet1])
      // eventos (linha do tempo, sem dinheiro) dos pedidos da frota continuam legíveis; os de outra frota não
      expect(await readAs(db, fleet1, 'select order_id from order_events', 'order_id')).toEqual([ID.oFleet1])
      expect(await readAs(db, fleet2, 'select order_id from order_events', 'order_id')).toEqual([])
    })

    test('fleet NÃO lê total_brl, itens, comissão nem nada que permita reconstruir o faturamento da loja', async () => {
      // 1. a tabela orders é invisível à frota, mesmo para o pedido que ela entregou
      expect(await orderIds(fleet1)).toEqual([])
      expect(await count(fleet1, 'orders', `id = '${ID.oFleet1}'`)).toBe(0)
      // 2. a view não tem as colunas de dinheiro do pedido
      const cols = (await asOwner<{ column_name: string }>(
        db, `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'fleet_orders'`)).map((c) => c.column_name)
      for (const c of ['total_brl', 'total_charged', 'pricing_breakdown', 'fx_rate_used', 'fx_rate_id', 'pricing_rule_id', 'client_id', 'merchant_id', 'payment_method', 'change_for', 'currency_charged']) {
        expect(cols, c).not.toContain(c)
      }
      await actAs(db, fleet1)
      for (const col of ['total_brl', 'pricing_breakdown', 'total_charged', 'merchant_id']) {
        const a = await attempt(db, `select ${col} from fleet_orders`)
        expect(!a.ok && a.code, col).toBe('42703')
      }
      // 3. para um pedido de comida (itens 40 + comissão 5 + base 10, total 50) a view devolve só a taxa de entrega
      const row = (await db.query(`select * from fleet_orders where id = $1`, [ID.oFleet1])).rows[0]
      expect(Number(row.delivery_fee_brl)).toBe(10)
      expect(JSON.stringify(row)).not.toMatch(/items_subtotal|commission|total/i)
      // 4. forma de array ({key, labelKey, amountBrl}) e chaves desconhecidas: só entram as linhas de entrega
      await asOwner(db, `update orders set pricing_breakdown = $1::jsonb where id = $2`, [
        JSON.stringify([
          { key: 'base', labelKey: 'x', amountBrl: 10 }, { key: 'night', labelKey: 'x', amountBrl: 3 },
          { key: 'cross_border', labelKey: 'x', amountBrl: 8 }, { key: 'items_subtotal', labelKey: 'x', amountBrl: 40 },
          { key: 'total', labelKey: 'x', amountBrl: 66 }, { key: 'service_fee', labelKey: 'x', amountBrl: 2 },
          { key: 'linha_nova_desconhecida', labelKey: 'x', amountBrl: 999 },
        ]), ID.oFleet1])
      await actAs(db, fleet1)
      expect(Number((await db.query(`select delivery_fee_brl from fleet_orders where id = $1`, [ID.oFleet1])).rows[0].delivery_fee_brl)).toBe(21)
      // 5. a view é somente leitura
      expectForbidden(await attempt(db, `update fleet_orders set status = 'entregue'`), 'update view')
      expectForbidden(await attempt(db, `delete from fleet_orders`), 'delete view')
      expectForbidden(await attempt(db, `insert into fleet_orders (id) values (gen_random_uuid())`), 'insert view')
      // 6. as tabelas do faturamento da loja continuam fechadas
      for (const t of [
        'merchants', 'merchants_public', 'merchant_hours', 'catalog_categories', 'catalog_items', 'item_option_groups', 'item_options',
        'order_items', 'audit_log',
      ]) {
        expect(await count(fleet1, t), t).toBe(0)
      }
      await actAs(db, fleet1)
      expectRefused(await attempt(db, `update orders set total_brl = 0.01 where id = $1`, [ID.oFleet1]), 'update orders')
      expectRefused(await attempt(db, `update merchants set commission_pct = 0 where id = $1`, [ID.shop1]), 'update merchants')
      expectRefused(await attempt(db, `update catalog_items set price_brl = 0.01 where id = $1`, [ID.item1]), 'update catalog')
      expectForbidden(await attempt(db, `insert into catalog_items (merchant_id, name, price_brl) values ($1, 'x', 1)`, [ID.shop1]), 'insert catalog')
    })

    test('fleet_orders: courier, merchant, client, admin e anon não leem; frota suspensa não lê', async () => {
      for (const w of [courierQ1, merchant1, clientA, admin]) expect(await count(w, 'fleet_orders'), JSON.stringify(w)).toBe(0)
      await actAs(db, 'anon')
      expectForbidden(await attempt(db, 'select * from fleet_orders'), 'anon')
      await asOwner(db, `update fleets set status = 'suspended' where id = $1`, [ID.fleet1])
      expect(await count(fleet1, 'fleet_orders')).toBe(0)
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
      expect(await count(fleet1, 'fleet_orders')).toBe(0)
      expect(await count(fleet1, 'order_events')).toBe(0)
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
      expect((await db.query('select public.is_admin() a, public.app_role() r')).rows[0]).toEqual({ a: false, r: null })
      expect(await count(blocked, 'merchants')).toBe(0)
      expect(await count(blocked, 'audit_log')).toBe(0)
      expect(await readAs(db, blocked, 'select id from profiles')).toEqual([ID.blockedAdmin]) // só o próprio
      await actAs(db, blocked)
      expectRefused(await attempt(db, `update pricing_rules set base_fare_brl = 99`), 'pricing_rules')
    })

    test('perfil pending ou blocked lê o PRÓPRIO profiles (para a tela de "aguardando aprovação") e mais nada', async () => {
      const pending: Who = { uid: ID.pendingCourier }
      expect(await readAs(db, pending, 'select id from profiles')).toEqual([ID.pendingCourier])
      expect(await readAs(db, { uid: ID.blockedAdmin }, 'select id from profiles')).toEqual([ID.blockedAdmin])
      for (const t of ['couriers', 'orders', 'courier_orders', 'fleet_orders', 'merchants', 'merchants_public', 'fleets', 'addresses', 'zones', 'fx_rates', 'status_transitions', 'pricing_rules', 'audit_log', 'order_events', 'courier_positions']) {
        expect(await count(pending, t), `pending ${t}`).toBe(0)
      }
      await actAs(db, pending)
      expectRefused(await attempt(db, `update profiles set full_name = 'x' where id = $1`, [ID.pendingCourier]), 'pending não edita')
      expectRefused(await attempt(db, `update profiles set status = 'active' where id = $1`, [ID.pendingCourier]), 'não se auto-aprova')
      // ao ser ativado pelo admin, o mesmo usuário passa a ter o papel
      await asOwner(db, `update profiles set status = 'active' where id = $1`, [ID.pendingCourier])
      expect(await count(pending, 'couriers')).toBeGreaterThan(0)
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
      const up = await attempt(db, `update pricing_rules set valid_to = current_date + 30 where city = 'quarai' and kind = 'food' and valid_to is null`)
      expect(up.ok && up.rowCount).toBe(1)
      expect((await attempt(db, `insert into fx_rates (rate, source, valid_for_date) values (7.9, 'manual', '2030-01-02')`)).ok).toBe(true)
    })

    test('fx_rates é histórico: nem o admin altera ou apaga uma linha (override e nova cotação são linhas novas)', async () => {
      const policies = await asOwner<{ cmd: string }>(db, `select cmd from pg_policies where schemaname = 'public' and tablename = 'fx_rates' order by cmd`)
      expect(policies.map((p) => p.cmd)).toEqual(['INSERT', 'SELECT', 'SELECT'])
      const snap = async () => (await asOwner<{ h: string }>(db, `select md5(string_agg(f::text, '|' order by f.id)) h from fx_rates f`))[0].h
      const before = await snap()
      for (const [name, w] of [...writers, ['admin', admin] as [string, Who]]) {
        await actAs(db, w)
        expectForbidden(await attempt(db, `update fx_rates set rate = 8.1 where id = $1`, [ID.fx1]), `${name} update`)
        expectForbidden(await attempt(db, `delete from fx_rates where id = $1`, [ID.fx1]), `${name} delete`)
      }
      expect(await snap()).toBe(before)
      // o gatilho vale também para o dono do banco e para o service_role (que ignora RLS e é a chave que o servidor tem)
      await actAs(db, 'postgres')
      expectForbidden(await attempt(db, `update fx_rates set rate = 1 where id = $1`, [ID.fx1]), 'dono do banco update')
      expectForbidden(await attempt(db, `delete from fx_rates where id = $1`, [ID.fx1]), 'dono do banco delete')
      expectForbidden(await attempt(db, `update fx_rates set rate = rate`), 'dono do banco update sem mudança')
      await db.query('set local role service_role')
      expectForbidden(await attempt(db, `update fx_rates set rate = 1 where id = $1`, [ID.fx1]), 'service_role update')
      expectForbidden(await attempt(db, `delete from fx_rates where id = $1`, [ID.fx1]), 'service_role delete')
      expectForbidden(await attempt(db, `delete from fx_rates`), 'service_role delete tudo')
      expect(await snap()).toBe(before)
      // inserir continua permitido, inclusive para o service_role (o job de câmbio): linha nova, nunca edição
      expect((await attempt(db, `insert into fx_rates (rate, source, valid_for_date) values (7.7, 'fxfeed', '2030-02-01')`)).ok).toBe(true)
      await actAs(db, 'postgres')
      const before2 = await snap() // inclui a linha nova
      // segunda parede: com os privilégios devolvidos (revertido no rollback), a RLS sozinha não deixa ninguém tocar a linha
      await asOwner(db, 'grant update, delete on public.fx_rates to authenticated')
      await actAs(db, admin)
      expectRefused(await attempt(db, `update fx_rates set rate = 8.1`), 'admin update (RLS)')
      expectRefused(await attempt(db, `delete from fx_rates`), 'admin delete (RLS)')
      expect(await snap()).toBe(before2)
      // o que o admin pode: acrescentar uma linha, inclusive um override manual no mesmo dia
      await actAs(db, admin)
      expect((await attempt(db, `insert into fx_rates (rate, source, is_manual_override, valid_for_date) values (8.0, 'manual', true, '2030-01-01')`)).ok).toBe(true)
    })

    test('pricing_rules: fechar uma versão (valid_to sozinho) é permitido ao admin e a nova versão é uma linha nova', async () => {
      await actAs(db, admin)
      const close = await attempt(db, `update pricing_rules set valid_to = current_date + 10 where city = 'quarai' and kind = 'food' and valid_to is null`)
      expect(close.ok && close.rowCount).toBe(1)
      expect((await attempt(db, `insert into pricing_rules (city, kind, base_fare_brl, included_km, per_km_brl, min_fare_brl, valid_from)
        values ('quarai', 'food', 11, 2, 2.5, 10, current_date + 10)`)).ok).toBe(true)
      // quem não é admin não fecha versão nenhuma (sem policy de update): zero linhas
      for (const w of [clientA, merchant1, fleet1, courierQ1]) {
        await actAs(db, w)
        expectRefused(await attempt(db, `update pricing_rules set valid_to = current_date + 5 where city = 'artigas' and kind = 'food' and valid_to is null`), JSON.stringify(w))
      }
      expect((await asOwner<{ n: number }>(db, `select count(*)::int n from pricing_rules where city = 'artigas' and kind = 'food' and valid_to is null`))[0].n).toBe(1)
    })

    test('pricing_rules: qualquer outra coluna é recusada, até para o admin; valid_to junto com outra coluna também', async () => {
      const snap = async () => (await asOwner<{ h: string }>(db, `select md5(string_agg(p::text, '|' order by p.id)) h from pricing_rules p`))[0].h
      const before = await snap()
      const open = `where city = 'quarai' and kind = 'food' and valid_to is null`
      await actAs(db, admin)
      for (const set of [
        'base_fare_brl = 99', 'per_km_brl = 99', "city = 'artigas'", "kind = 'ride'", 'min_fare_brl = 1', 'included_km = 9', 'night_surcharge_brl = 0',
        'cross_border_fee_brl = 0', 'service_fee_pct = 50', "valid_from = '2025-01-01'", `created_by = '${ID.admin}'`,
        // a close that carries a price change along is a price change
        'valid_to = current_date + 10, base_fare_brl = 99', 'valid_to = current_date + 10, per_km_brl = 0.01', "valid_to = current_date + 10, city = 'artigas'",
      ]) {
        expectForbidden(await attempt(db, `update pricing_rules set ${set} ${open}`), set)
      }
      expect(await snap()).toBe(before)
      // o dono do banco e o service_role também (o gatilho não depende de papel)
      await actAs(db, 'postgres')
      expectForbidden(await attempt(db, `update pricing_rules set base_fare_brl = 99 ${open}`), 'dono do banco')
      await db.query('set local role service_role')
      expectForbidden(await attempt(db, `update pricing_rules set base_fare_brl = 99 ${open}`), 'service_role')
      expect(await snap()).toBe(before)
      // um UPDATE que não muda nada passa (sem edição, nada a proteger)
      await actAs(db, admin)
      const noop = await attempt(db, `update pricing_rules set base_fare_brl = base_fare_brl ${open}`)
      expect(noop.ok && noop.rowCount).toBe(1)
    })

    test('pricing_rules: DELETE recusado para todos os papéis, inclusive admin, dono do banco e service_role', async () => {
      const snap = async () => (await asOwner<{ h: string }>(db, `select md5(string_agg(p::text, '|' order by p.id)) h from pricing_rules p`))[0].h
      const before = await snap()
      const dels = (await asOwner<{ cmd: string }>(db, `select cmd from pg_policies where schemaname = 'public' and tablename = 'pricing_rules'`)).map((p) => p.cmd)
      expect(dels).not.toContain('DELETE')
      for (const [name, w] of [...writers, ['admin', admin] as [string, Who]]) {
        await actAs(db, w)
        const a = await attempt(db, `delete from pricing_rules`)
        if (name === 'admin') expectForbidden(a, name) // privilégio revogado
        else expectRefused(a, name)
      }
      // segunda parede: com o privilégio devolvido e a policy recriada por engano, o gatilho ainda recusa
      await asOwner(db, 'grant delete on public.pricing_rules to authenticated')
      await asOwner(db, `create policy tmp_oops_del on public.pricing_rules for delete to authenticated using (true)`)
      await actAs(db, admin)
      expectForbidden(await attempt(db, `delete from pricing_rules`), 'admin com policy frouxa')
      await actAs(db, 'postgres')
      expectForbidden(await attempt(db, `delete from pricing_rules`), 'dono do banco')
      await db.query('set local role service_role')
      expectForbidden(await attempt(db, `delete from pricing_rules`), 'service_role')
      expect(await snap()).toBe(before)
      expect((await asOwner<{ n: number }>(db, `select count(*)::int n from pricing_rules where valid_to is null`))[0].n).toBeGreaterThanOrEqual(6)
    })

    test('o seed idempotente continua rodando com o gatilho (insert ... where not exists não é bloqueado nem duplica)', async () => {
      const seed = readFileSync(resolve(process.cwd(), 'supabase/seed.sql'), 'utf8')
      const count = async () => (await asOwner<{ n: number }>(db, `select count(*)::int n from pricing_rules`))[0].n
      const before = await count()
      await actAs(db, 'postgres')
      await db.query(seed)
      await db.query(seed)
      expect(await count()).toBe(before)
      // e uma versão nova inserida depois que a antiga foi fechada também passa pelo gatilho
      await asOwner(db, `update pricing_rules set valid_to = current_date + 10 where city = 'artigas' and kind = 'ride' and valid_to is null`)
      await asOwner(db, `insert into pricing_rules (city, kind, base_fare_brl, included_km, per_km_brl, min_fare_brl, valid_from) values ('artigas', 'ride', 11, 2, 2.5, 10, current_date + 10)`)
      expect(await count()).toBe(before + 1)
    })

    test('TRUNCATE não apaga o histórico: pricing_rules, fx_rates e audit_log, nem para service_role nem para o dono do banco', async () => {
      const privs = await asOwner<{ t: string; svc: boolean; auth: boolean; anon: boolean }>(
        db,
        `select t, has_table_privilege('service_role', 'public.' || t, 'truncate') svc, has_table_privilege('authenticated', 'public.' || t, 'truncate') auth,
                has_table_privilege('anon', 'public.' || t, 'truncate') anon
         from unnest(array['pricing_rules', 'fx_rates', 'audit_log']) t`,
      )
      for (const p of privs) expect({ t: p.t, svc: p.svc, auth: p.auth, anon: p.anon }, p.t).toEqual({ t: p.t, svc: false, auth: false, anon: false })
      const hist = async () => (await asOwner<{ n: number }>(db, `select ((select count(*) from pricing_rules) + (select count(*) from fx_rates) + (select count(*) from audit_log))::int n`))[0].n
      const before = await hist()
      expect(before).toBeGreaterThan(0)
      await db.query('reset role')
      await db.query('set local role service_role')
      for (const t of ['pricing_rules', 'fx_rates', 'audit_log']) expectForbidden(await attempt(db, `truncate public.${t} cascade`), `service_role truncate ${t}`)
      // o dono do banco tem o privilégio, mas o gatilho de statement recusa (o CASCADE dispara o gatilho de cada tabela atingida)
      await actAs(db, 'postgres')
      for (const t of ['pricing_rules', 'fx_rates', 'audit_log']) expectForbidden(await attempt(db, `truncate public.${t} cascade`), `dono truncate ${t}`)
      expect(await hist()).toBe(before)
    })

    test('comissão: nenhum papel lê chave de comissão dentro de pricing_breakdown, e o banco recusa gravá-la', async () => {
      // 1. nenhum papel enxerga "commission"/"comiss" em nenhum breakdown que consegue ler
      for (const [name, w] of [['clientA', clientA], ['clientB', clientB], ['merchant1', merchant1], ['merchant2', merchant2], ['admin', admin]] as [string, Who][]) {
        await actAs(db, w)
        const r = await db.query(`select pricing_breakdown::text as b from orders where pricing_breakdown is not null`)
        expect(r.rows.length, name).toBeGreaterThan(0)
        for (const row of r.rows) expect(row.b, name).not.toMatch(/commission|comiss/i)
      }
      // o cliente continua vendo o breakdown linha a linha
      await actAs(db, clientA)
      const own = (await db.query(`select pricing_breakdown from orders where id = $1`, [ID.oFleet1])).rows[0].pricing_breakdown
      expect(own).toEqual({ base: 10, items_subtotal: 40 })
      // 2. o CHECK recusa qualquer forma de comissão no breakdown, para qualquer papel (dono do banco e admin incluídos)
      for (const bad of [
        '{"base": 10, "commission": 5}',
        '{"base": 10, "Commission_BRL": 5}',
        '{"lines": [{"key": "commission", "labelKey": "pricing.commission", "amountBrl": 5}]}',
        '[{"key": "comissao", "labelKey": "x", "amountBrl": 5}]',
        '{"base": 10, "nested": {"deep": {"comissão": 5}}}',
      ]) {
        for (const who of ['postgres', admin] as Who[]) {
          await actAs(db, who)
          const a = await attempt(db, `update orders set pricing_breakdown = $1::jsonb where id = $2`, [bad, ID.oQueueQ])
          expect(!a.ok && a.code, `${who === 'postgres' ? 'dono' : 'admin'} ${bad}`).toBe('23514')
        }
      }
      await actAs(db, 'postgres')
      const ins = await attempt(
        db,
        `insert into orders (kind, client_id, pickup_address, dropoff_address, total_brl, total_charged, payment_method, pricing_breakdown)
         values ('courier', $1, '{}', '{}', 10, 10, 'pix', '{"commission": 1}')`, [ID.clientA])
      expect(!ins.ok && ins.code).toBe('23514')
      // 3. um breakdown só com linhas de cliente é aceito
      await actAs(db, admin)
      expect((await attempt(db, `update orders set pricing_breakdown = '{"base": 10, "included_km": 2, "extra_km": 1.5, "night": 3, "cross_border": 8, "items_subtotal": 40, "total": 61.5}' where id = $1`, [ID.oQueueQ])).ok).toBe(true)
    })

    test('comissão: só merchant (da própria loja, pedido enviado) e admin leem order_commissions; ninguém além do admin escreve', async () => {
      expect(await readAs(db, merchant1, 'select order_id from order_commissions', 'order_id')).toEqual([ID.oFleet1]) // não o da loja 2, nem o pedido ainda "criado"
      expect(await readAs(db, merchant2, 'select order_id from order_commissions', 'order_id')).toEqual([ID.oQueueA])
      await actAs(db, merchant1)
      const mine = (await db.query(`select commission_brl from order_commissions where order_id = $1`, [ID.oFleet1])).rows[0]
      expect(mine.commission_brl).toBe('5.00')
      for (const [name, w] of [['client', clientA], ['courier', courierQ1], ['fleet', fleet1]] as [string, Who][]) expect(await count(w, 'order_commissions'), name).toBe(0)
      await actAs(db, 'anon')
      expectForbidden(await attempt(db, 'select * from order_commissions'), 'anon')
      // escrita: ninguém além do admin
      for (const [name, w] of [['client', clientA], ['merchant', merchant1], ['courier', courierQ1], ['fleet', fleet1]] as [string, Who][]) {
        await actAs(db, w)
        expectForbidden(await attempt(db, `insert into order_commissions (order_id, commission_brl) values ($1, 0)`, [ID.oShop1New]), `${name} insert`)
        expectRefused(await attempt(db, `update order_commissions set commission_brl = 0`), `${name} update`)
        expectRefused(await attempt(db, `delete from order_commissions`), `${name} delete`)
      }
      expect((await asOwner<{ n: number }>(db, `select count(*)::int n from order_commissions where commission_brl = 0`))[0].n).toBe(0)
      // trigger de congelamento independente da policy: mesmo com uma policy de update frouxa, só o admin muda
      await asOwner(db, `create policy tmp_oops on public.order_commissions for update to authenticated using (true) with check (true)`)
      await actAs(db, merchant1)
      expectForbidden(await attempt(db, `update order_commissions set commission_brl = 0 where order_id = $1`, [ID.oFleet1]), 'merchant com policy frouxa')
      await actAs(db, admin)
      expect((await attempt(db, `update order_commissions set commission_brl = 5.50 where order_id = $1`, [ID.oFleet1])).ok).toBe(true)
      expect((await attempt(db, `insert into order_commissions (order_id, commission_brl) values ($1, 4.00)`, [ID.oShop1New])).ok).toBe(true)
      // e a comissão não aparece nas views de frota e de courier
      for (const [view, w] of [['fleet_orders', fleet1], ['courier_orders', courierQ1]] as [string, Who][]) {
        const cols = (await asOwner<{ column_name: string }>(db, `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`, [view])).map((c) => c.column_name)
        expect(cols.join(','), view).not.toMatch(/commission|comiss/)
        await actAs(db, w)
        const rows = (await db.query(`select * from ${view}`)).rows
        expect(JSON.stringify(rows), view).not.toMatch(/commission|comiss/i)
      }
    })

    test('auditoria cobre item_options, item_option_groups, merchant_hours, fleets e order_commissions, com ator e papel', async () => {
      await actAs(db, merchant1)
      expect((await attempt(db, `update item_options set price_delta_brl = 9.00 where id = $1`, [ID.opt1])).ok).toBe(true)
      expect((await attempt(db, `update item_option_groups set name = 'Extras' where id = $1`, [ID.group1])).ok).toBe(true)
      expect((await attempt(db, `update merchant_hours set closes_at = '23:00' where merchant_id = $1`, [ID.shop1])).ok).toBe(true)
      await actAs(db, fleet1)
      expect((await attempt(db, `update fleets set name = 'Tele Quarai Plus' where id = $1`, [ID.fleet1])).ok).toBe(true)
      await actAs(db, admin)
      expect((await attempt(db, `update order_commissions set commission_brl = 7 where order_id = $1`, [ID.oFleet1])).ok).toBe(true)
      const r = await asOwner<{ table_name: string; record_id: string; actor_id: string; actor_role: string; before: Record<string, unknown>; after: Record<string, unknown> }>(
        db, `select table_name, record_id, actor_id, actor_role, before, after from audit_log where action = 'UPDATE' and actor_id is not null
             and table_name in ('item_options', 'item_option_groups', 'merchant_hours', 'fleets', 'order_commissions') order by id`)
      expect(r.map((x) => [x.table_name, x.actor_role])).toEqual([
        ['item_options', 'merchant'], ['item_option_groups', 'merchant'], ['merchant_hours', 'merchant'], ['fleets', 'fleet'], ['order_commissions', 'admin'],
      ])
      expect(Number(r[0].before.price_delta_brl)).toBe(3)
      expect(Number(r[0].after.price_delta_brl)).toBe(9)
      expect(r[4].record_id).toBe(ID.oFleet1)
      expect(Number(r[4].before.commission_brl)).toBe(5)
      expect(Number(r[4].after.commission_brl)).toBe(7)
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
      expect((await db.query('select public.app_role() r, public.is_admin() a')).rows[0]).toEqual({ r: 'client', a: false })
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
      expect((await db.query('select public.app_role() r')).rows[0].r).toBe('client')
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
      // a única edição possível: fechar a versão vigente
      const up = await attempt(db, `update pricing_rules set valid_to = current_date + 30 where city = 'quarai' and kind = 'food' and valid_to is null returning id`)
      expect(up.ok && up.rowCount).toBe(1)
      const id = ((up as unknown) as { rows: { id: string }[] }).rows[0].id
      // e a nova versão é uma linha nova, que também é auditada
      const ins = await attempt(db, `insert into pricing_rules (city, kind, base_fare_brl, included_km, per_km_brl, min_fare_brl, valid_from)
         values ('quarai', 'food', 12, 2, 3, 12, current_date + 30) returning id`)
      expect(ins.ok).toBe(true)
      const newId = ((ins as unknown) as { rows: { id: string }[] }).rows[0].id
      const log = await asOwner<{ actor_id: string; actor_role: string; action: string; record_id: string; before: Record<string, string | null> | null; after: Record<string, string | null> | null }>(
        db, `select * from audit_log where table_name = 'pricing_rules' and record_id = any($1::text[]) order by id`, [[id, newId]])
      expect(log.map((l) => l.action)).toEqual(['UPDATE', 'INSERT'])
      expect(log[0]).toMatchObject({ actor_id: ID.admin, actor_role: 'admin', record_id: id })
      expect(log[0].before!.valid_to).toBeNull()
      expect(log[0].after!.valid_to).toBeTruthy()
      expect(Number(log[0].before!.base_fare_brl)).toBe(Number(log[0].after!.base_fare_brl))
      expect(log[0].before!.id).toBe(id)
      expect(log[1]).toMatchObject({ actor_id: ID.admin, actor_role: 'admin', record_id: newId, before: null })
      expect(Number(log[1].after!.base_fare_brl)).toBe(12)
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

    test('as catorze tabelas sensíveis têm o trigger de auditoria e as demais não', async () => {
      const r = await asOwner<{ relname: string }>(
        db,
        `select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
         where not t.tgisinternal and t.tgfoid = 'public.audit_write'::regproc order by 1`,
      )
      expect(r.map((x) => x.relname)).toEqual(
        ['catalog_categories', 'catalog_items', 'couriers', 'fleets', 'fx_rates', 'item_option_groups', 'item_options', 'merchant_hours', 'merchants', 'order_commissions', 'pricing_rules', 'profiles', 'settings', 'zones'],
      )
    })

    test('mudança de role em profiles e escrita em settings/couriers/zones/merchants e insert em fx_rates ficam registradas com o ator', async () => {
      await actAs(db, admin)
      expect((await attempt(db, `update profiles set role = 'merchant' where id = $1`, [ID.clientB])).ok).toBe(true)
      expect((await attempt(db, `update settings set value = '"novo"' where key = 'rls_fixture_private'`)).ok).toBe(true)
      expect((await attempt(db, `update couriers set status = 'suspended' where profile_id = $1`, [ID.courierQ1])).ok).toBe(true)
      expect((await attempt(db, `update zones set is_served = false where name like 'Centro%'`)).ok).toBe(true)
      expect((await attempt(db, `update merchants set commission_pct = 20 where id = $1`, [ID.shop1])).ok).toBe(true)
      const fxIns = await attempt(db, `insert into fx_rates (rate, source, valid_for_date) values (8.1, 'manual', '2030-01-03') returning id`)
      const r = await asOwner<{ table_name: string; record_id: string; before: Record<string, unknown>; after: Record<string, unknown> }>(
        db, `select table_name, record_id, before, after from audit_log where actor_id = $1 and action = 'UPDATE' order by id`, [ID.admin])
      expect(r.map((x) => x.table_name)).toEqual(['profiles', 'settings', 'couriers', 'zones', 'merchants'])
      expect(r.map((x) => x.record_id)).toEqual([ID.clientB, 'rls_fixture_private', ID.courierQ1, expect.any(String), ID.shop1])
      const fxId = ((fxIns as unknown) as { rows: { id: string }[] }).rows[0].id
      const fxLog = await asOwner<{ actor_id: string; actor_role: string; action: string; before: unknown }>(
        db, `select actor_id, actor_role, action, before from audit_log where table_name = 'fx_rates' and record_id = $1`, [fxId])
      expect(fxLog).toEqual([{ actor_id: ID.admin, actor_role: 'admin', action: 'INSERT', before: null }])
      expect(r[0].before.role).toBe('client')
      expect(r[0].after.role).toBe('merchant')
    })

    test('toggle operacional de couriers (is_online) NÃO entra em audit_log; mudança real, insert e delete entram', async () => {
      const n = async () => (await asOwner<{ n: number }>(db, `select count(*)::int n from audit_log where table_name = 'couriers' and record_id = $1 and action = 'UPDATE'`, [ID.courierQ1]))[0].n
      const base = await n()
      await actAs(db, courierQ1)
      expect((await attempt(db, `update couriers set is_online = true where profile_id = $1`, [ID.courierQ1])).ok).toBe(true)
      expect((await attempt(db, `update couriers set is_online = false where profile_id = $1`, [ID.courierQ1])).ok).toBe(true)
      expect(await n()).toBe(base) // dois toggles, zero linhas de auditoria
      await actAs(db, courierQ1)
      expect((await attempt(db, `update couriers set plate = 'XYZ9K88' where profile_id = $1`, [ID.courierQ1])).ok).toBe(true)
      expect(await n()).toBe(base + 1)
      await actAs(db, courierQ1)
      expect((await attempt(db, `update couriers set is_online = true, vehicle = 'bike' where profile_id = $1`, [ID.courierQ1])).ok).toBe(true)
      expect(await n()).toBe(base + 2) // toggle misturado com mudança real continua registrado
      await actAs(db, admin)
      expect((await attempt(db, `update couriers set status = 'suspended' where profile_id = $1`, [ID.courierQ1])).ok).toBe(true)
      expect(await n()).toBe(base + 3)
      expect((await attempt(db, `delete from couriers where profile_id = $1`, [ID.pendingCourier])).ok).toBe(true)
      expect((await asOwner(db, `select 1 from audit_log where table_name = 'couriers' and record_id = $1 and action = 'DELETE'`, [ID.pendingCourier])).length).toBe(1)
      // a lista de ignorados é por tabela: is_available de catalog_items continua auditado
      await actAs(db, merchant1)
      expect((await attempt(db, `update catalog_items set is_available = false where id = $1`, [ID.item1])).ok).toBe(true)
      expect((await asOwner(db, `select 1 from audit_log where table_name = 'catalog_items' and record_id = $1 and action = 'UPDATE'`, [ID.item1])).length).toBe(1)
    })

    test('mudança de phone em profiles continua auditada (dado pessoal), legível só pelo admin', async () => {
      await actAs(db, clientA)
      expect((await attempt(db, `update profiles set phone = '+5555999990000' where id = $1`, [ID.clientA])).ok).toBe(true)
      const r = await asOwner<{ actor_id: string; before: Record<string, unknown>; after: Record<string, unknown> }>(
        db, `select actor_id, before, after from audit_log where table_name = 'profiles' and record_id = $1 and action = 'UPDATE' and actor_id is not null`, [ID.clientA]) // actor_id is not null: o upsert do fixture (dono, sem sessao) tambem gera uma linha de UPDATE
      expect(r).toHaveLength(1)
      expect(r[0].actor_id).toBe(ID.clientA)
      expect(r[0].before.phone).toBeNull()
      expect(r[0].after.phone).toBe('+5555999990000')
      expect(await count(clientA, 'audit_log')).toBe(0)
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
      for (const w of [merchant1]) {
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
  let A: (typeof created)[number], C: (typeof created)[number], B: (typeof created)[number], D: (typeof created)[number], E: (typeof created)[number]
  let orderA: string, orderC: string, orderF: string, orderK: string, orderQ: string, fleetId: string
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
    await committer.query('delete from public.fleets where owner_id = any($1::uuid[])', [ids])
    for (const u of created) {
      await fetch(`${URL_}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: { apikey: SECRET, Authorization: `Bearer ${SECRET}` } })
    }
    await committer.query(`delete from public.profiles where id = any($1::uuid[])`, [ids])
    await committer.query(
      `delete from public.audit_log where table_name in ('profiles', 'couriers', 'fleets', 'order_commissions') and record_id = any($1::text[])`,
      [[...ids, ...orderIds_, ...(fleetId ? [fleetId] : [])]],
    )
  }

  beforeAll(async () => {
    expect(URL_ && PUB && SECRET, 'Supabase URL/keys must be in .env.local').toBeTruthy()
    committer = await connect()
    try {
      pricingBefore = (await committer.query(`select md5(string_agg(p::text, '|' order by p.id)) h from public.pricing_rules p`)).rows[0].h
      ;[A, C, B, D, E] = [await createUser('a'), await createUser('c'), await createUser('b'), await createUser('d'), await createUser('e')]
      await committer.query(
        `insert into public.profiles (id, role, full_name) values ($1, 'client', 'E2E A'), ($2, 'client', 'E2E C'), ($3, 'admin', 'E2E Admin'), ($4, 'fleet', 'E2E Fleet'), ($5, 'courier', 'E2E Courier')
         on conflict (id) do update set role = excluded.role, full_name = excluded.full_name`,
        [A.id, C.id, B.id, D.id, E.id],
      )
      await committer.query(
        `insert into public.couriers (profile_id, vehicle, base_city, status) values ($1, 'moto', 'quarai', 'approved')`, [E.id])
      // food order carried by courier E: items 40, commission 5, delivery 10, total 50, cash with change for 100
      orderK = (await committer.query(
        `insert into public.orders (kind, client_id, courier_id, pickup_address, dropoff_address, total_brl, total_charged, payment_method, change_for, status, pricing_breakdown)
         values ('food', $1, $2, '{"city":"quarai"}', '{"city":"quarai"}', 50.00, 50.00, 'dinheiro_brl', 100.00, 'coletado',
                 '{"base": 10, "items_subtotal": 40, "total": 50}') returning id`, [A.id, E.id])).rows[0].id
      await committer.query(`insert into public.order_commissions (order_id, commission_brl) values ($1, 5.00)`, [orderK])
      // and one order still in the quarai queue
      orderQ = (await committer.query(
        `insert into public.orders (kind, client_id, pickup_address, dropoff_address, total_brl, total_charged, payment_method, status, pricing_breakdown)
         values ('courier', $1, '{"city":"quarai"}', '{"city":"quarai"}', 25.00, 25.00, 'pix', 'aguardando_motoboy', '{"base": 10}') returning id`, [A.id])).rows[0].id
      await committer.query(`insert into public.order_items (order_id, name_snapshot, unit_price_brl_snapshot, qty, line_total_brl) values ($1, 'X-Pampa', 20.00, 2, 40.00)`, [orderK])
      await committer.query(`insert into public.order_events (order_id, from_status, to_status, actor_role) values ($1, 'pronto', 'coletado', 'courier')`, [orderK])
      fleetId = (await committer.query(
        `insert into public.fleets (owner_id, name, city, status) values ($1, 'E2E Tele', 'quarai', 'approved') returning id`, [D.id])).rows[0].id
      // a food order served by D's fleet: total 50 = delivery 10 + items 40, commission 5 (merchant revenue)
      orderF = (await committer.query(
        `insert into public.orders (kind, client_id, fleet_id, pickup_address, dropoff_address, total_brl, total_charged, payment_method, status, pricing_breakdown)
         values ('food', $1, $2, '{"city":"quarai"}', '{"city":"quarai"}', 50.00, 50.00, 'pix', 'coletado',
                 '{"base": 10, "items_subtotal": 40, "total": 50}') returning id`,
        [A.id, fleetId])).rows[0].id
      await committer.query(`insert into public.order_commissions (order_id, commission_brl) values ($1, 5.00)`, [orderF])
      const ins = (client: string) =>
        committer.query(
          `insert into public.orders (kind, client_id, pickup_address, dropoff_address, total_brl, total_charged, payment_method, status)
           values ('courier', $1, '{"city":"quarai"}', '{"city":"quarai"}', 25.00, 25.00, 'pix', 'criado') returning id`,
          [client],
        )
      orderA = (await ins(A.id)).rows[0].id
      orderC = (await ins(C.id)).rows[0].id
      orderIds_.push(orderA, orderC, orderF, orderK, orderQ)
      for (const u of [A, C, B, D, E]) u.token = await signIn(u)
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
                (select count(*)::int from public.audit_log where table_name in ('profiles', 'couriers', 'fleets', 'order_commissions') and record_id = any($3::text[])) a,
                (select count(*)::int from public.order_commissions where order_id = any($2::uuid[])) c,
                (select count(*)::int from auth.users where id = any($1::uuid[])) u,
                (select count(*)::int from public.fleets where owner_id = any($1::uuid[])) f`,
        [created.map((u) => u.id), orderIds_, [...created.map((u) => u.id), ...orderIds_, ...(fleetId ? [fleetId] : [])]],
      )
      expect(left.rows[0]).toEqual({ p: 0, o: 0, a: 0, c: 0, u: 0, f: 0 })
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
    expect(ord.json.map((r: { id: string }) => r.id).sort()).toEqual(sorted(orderA, orderF, orderK, orderQ))
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
    // a comissão: nem coluna em orders, nem breakdown, nem a tabela
    expect((await rest('order_commissions?select=*', A.token!)).json).toEqual([])
    const bd = await rest('orders?select=id,pricing_breakdown', A.token!)
    expect(bd.json.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(bd.json)).not.toMatch(/commission|comiss/i)
    expect(bd.json.find((r: { id: string }) => r.id === orderF).pricing_breakdown).toEqual({ base: 10, items_subtotal: 40, total: 50 }) // o cliente vê o breakdown
    const col = await rest(`orders?select=commission_brl&id=eq.${orderF}`, A.token!)
    expect(col.status).toBe(400)
    expect(col.json.code).toBe('42703')
    const bad = await rest(`orders?id=eq.${orderA}`, A.token!, { method: 'PATCH', body: { pricing_breakdown: { base: 1, commission: 5 } } })
    expect(bad.status).toBe(403) // o trigger de colunas recusa antes do CHECK
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
    expect((await rest('merchants?select=id,commission_pct', forgedToken)).json).toEqual([])
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
    // o admin lê a comissão (e só ele e o merchant dono da loja)
    const com = await rest(`order_commissions?select=commission_brl&order_id=eq.${orderF}`, B.token!)
    expect(com.json).toEqual([{ commission_brl: 5 }])
  })

  test('client: vitrine só pela view merchants_public, sem comissão', async () => {
    const view = await rest('merchants_public?select=id,name,is_open_manual', A.token!)
    expect(view.status).toBe(200)
    expect(view.json.length).toBeGreaterThanOrEqual(2) // as duas lojas de exemplo aprovadas
    const peek = await rest('merchants_public?select=commission_pct', A.token!)
    expect(peek.status).toBe(400)
    expect(peek.json.code).toBe('42703')
    expect((await rest('merchants?select=id,commission_pct', A.token!)).json).toEqual([])
    const w = await rest('merchants_public?name=like.*', A.token!, { method: 'PATCH', body: { name: 'x' } })
    expect(w.status).toBeGreaterThanOrEqual(400)
    expect((await rest('merchants_public?select=id', null)).status).toBeGreaterThanOrEqual(400) // anon
  })

  test('courier (token real): o valor a cobrar existe; comissão, subtotal de itens e breakdown não são alcançáveis por caminho nenhum', async () => {
    const T = E.token!
    const v = await rest('courier_orders?select=*&order=created_at', T)
    expect(v.status).toBe(200)
    const byId = Object.fromEntries(v.json.map((r: { id: string }) => [r.id, r]))
    expect(Object.keys(byId).sort()).toEqual(sorted(orderK, orderQ)) // o que ele carrega + a fila de Quarai
    // o pedido que carrega: dinheiro, total 50, troco para 100, taxa de entrega 10
    expect(byId[orderK]).toMatchObject({ total_charged: 50, change_for: 100, payment_method: 'dinheiro_brl', currency_charged: 'BRL', delivery_fee_brl: 10 })
    // o da fila: sem valores a cobrar
    expect(byId[orderQ]).toMatchObject({ payment_method: 'pix', total_charged: null, change_for: null })
    const keys = new Set(v.json.flatMap((r: object) => Object.keys(r)))
    for (const k of ['total_brl', 'pricing_breakdown', 'fx_rate_used', 'fx_rate_id', 'pricing_rule_id', 'client_id', 'merchant_id']) expect(keys.has(k), k).toBe(false)
    expect(JSON.stringify(v.json)).not.toMatch(/items_subtotal|commission|breakdown/)
    for (const col of ['total_brl', 'pricing_breakdown', 'fx_rate_used']) {
      const r = await rest(`courier_orders?select=${col}`, T)
      expect(r.status, col).toBe(400)
      expect(r.json.code).toBe('42703')
    }
    for (const path of ['orders?select=*', `orders?select=pricing_breakdown,total_brl&id=eq.${orderK}`, 'order_items?select=*', 'merchants?select=*', 'merchants_public?select=*',
      'catalog_items?select=*', 'audit_log?select=*', 'order_commissions?select=*', 'fleet_orders?select=*', 'profiles?select=id&id=neq.' + E.id]) {
      const r = await rest(path, T)
      expect(r.status, path).toBe(200)
      expect(r.json, path).toEqual([])
    }
    // embeds a partir de uma tabela que ele lê também não vazam o breakdown
    const emb = await rest('couriers?select=profile_id,orders(pricing_breakdown,total_brl)', T)
    expect(JSON.stringify(emb.json)).not.toMatch(/commission|items_subtotal|total_brl/)
    // escrever: nem pela view nem pela tabela
    expect((await rest(`courier_orders?id=eq.${orderK}`, T, { method: 'PATCH', body: { status: 'entregue' } })).status).toBeGreaterThanOrEqual(400)
    const w2 = await rest(`orders?id=eq.${orderQ}`, T, { method: 'PATCH', body: { courier_id: E.id, status: 'aceito' }, prefer: 'return=representation' })
    expect(w2.json).toEqual([])
    const [dbRow] = (await committer.query('select courier_id, status, total_brl from public.orders where id = $1', [orderQ])).rows
    expect(dbRow).toEqual({ courier_id: null, status: 'aguardando_motoboy', total_brl: '25.00' })
    // a linha do tempo do pedido que carrega continua legível; e ele publica a posição
    const ev = await rest(`order_events?select=to_status&order_id=eq.${orderK}`, T)
    expect(ev.json).toEqual([{ to_status: 'coletado' }])
    const pos = await rest('courier_positions', T, { method: 'POST', body: { courier_id: E.id, order_id: orderK, lat: -30.38, lng: -56.45 } })
    expect(pos.status).toBe(201)
    await committer.query('delete from public.courier_positions where courier_id = $1', [E.id])
  })

  test('fleet (token real) NÃO alcança total_brl por nenhum caminho, nem pela view fleet_orders', async () => {
    const T = D.token!
    // a view entrega o pedido servido, só com a taxa de entrega
    const v = await rest('fleet_orders?select=*', T)
    expect(v.status).toBe(200)
    expect(v.json).toHaveLength(1)
    expect(v.json[0].id).toBe(orderF)
    expect(v.json[0].delivery_fee_brl).toBe(10)
    const keys = Object.keys(v.json[0])
    for (const k of ['total_brl', 'total_charged', 'pricing_breakdown', 'fx_rate_used', 'client_id', 'merchant_id']) expect(keys).not.toContain(k)
    expect(JSON.stringify(v.json)).not.toMatch(/items_subtotal|commission|"total/)
    // pedir a coluna explicitamente falha
    for (const col of ['total_brl', 'pricing_breakdown', 'total_charged']) {
      const r = await rest(`fleet_orders?select=${col}`, T)
      expect(r.status, col).toBe(400)
      expect(r.json.code).toBe('42703')
    }
    // a tabela base, itens, lojas e catálogo: vazios
    for (const path of ['orders?select=*', `orders?select=total_brl&id=eq.${orderF}`, 'order_items?select=*', 'merchants?select=*', 'merchants_public?select=*',
      'catalog_items?select=*', 'catalog_categories?select=*', 'audit_log?select=*', 'order_commissions?select=*', 'couriers?select=*&fleet_id=is.null']) {
      const r = await rest(path, T)
      expect(r.status, path).toBe(200)
      expect(r.json, path).toEqual([])
    }
    // embutir orders a partir de outra tabela também não vaza (embed é filtrado pela mesma RLS)
    const emb = await rest('fleets?select=id,orders(total_brl)', T)
    expect(JSON.stringify(emb.json)).not.toMatch(/total_brl":\s*50/)
    // escrever: nem pela view nem pela tabela
    const w1 = await rest(`fleet_orders?id=eq.${orderF}`, T, { method: 'PATCH', body: { status: 'entregue' } })
    expect(w1.status).toBeGreaterThanOrEqual(400)
    const w2 = await rest(`orders?id=eq.${orderF}`, T, { method: 'PATCH', body: { total_brl: 0.01 }, prefer: 'return=representation' })
    expect(w2.json).toEqual([])
    const [dbRow] = (await committer.query('select total_brl, status from public.orders where id = $1', [orderF])).rows
    expect(dbRow).toEqual({ total_brl: '50.00', status: 'coletado' })
  })
})
