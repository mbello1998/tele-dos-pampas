import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { connect } from '../../scripts/db/client'
import { withDeadlockRetry } from '../../src/app/admin/despacho/retry'
import { legalTargets, type TransitionRow } from '../../src/app/admin/despacho/transitions'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 })

/**
 * transition_order e assign_courier: a máquina de estados do pedido e o despacho manual do admin.
 *
 * FIXTURES. create_order é de outra tarefa e pode não existir: os pedidos são inseridos direto em `orders` (e
 * `order_events`) dentro de uma transação que SEMPRE termina em rollback. Só a seção de concorrência precisa de
 * linhas commitadas (duas conexões vivas); ela usa um prefixo de id próprio e apaga exatamente o que criou.
 *
 * MUTAÇÃO. Com TRANSITION_MUTANT=<nome> os testes não chamam public.transition_order / public.assign_courier:
 * reconstroem as duas funções no schema TEMP (pg_temp) da própria sessão, com UM defeito aplicado ao texto SQL
 * da migration, e chamam a cópia. 'baseline' não aplica defeito e tem de passar tudo (prova que a cópia é
 * equivalente ao que está implantado). Nenhuma função compartilhada é alterada.
 *   TRANSITION_MUTANT=no-lock npx vitest run tests/db/transition.test.ts
 */
type Edit = { fn: 'transition_order' | 'assign_courier'; from: string; to: string }
const MUTANTS: Record<string, Edit[]> = {
  baseline: [],
}

const MUTANT = process.env.TRANSITION_MUTANT
const SCHEMA = MUTANT ? 'pg_temp' : 'public'
const TRANSITION = `${SCHEMA}.transition_order`
const ASSIGN = `${SCHEMA}.assign_courier`

const MIGRATION = resolve(process.cwd(), 'supabase/migrations/0026_transition_order.sql')

/** The CREATE FUNCTION text of one function out of the migration, with the defect (if any) applied. */
function functionSource(name: 'transition_order' | 'assign_courier') {
  const src = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n')
  const start = src.indexOf(`create function public.${name}(`)
  if (start < 0) throw new Error(`${name} not found in the migration`)
  const end = src.indexOf('\n$$;', start)
  let text = src.slice(start, end + 4).replace(`create function public.${name}(`, `create or replace function pg_temp.${name}(`)
  for (const edit of MUTANTS[MUTANT ?? 'baseline'] ?? (() => { throw new Error(`unknown mutant ${MUTANT}`) })()) {
    if (edit.fn !== name) continue
    const n = text.split(edit.from).length - 1
    if (n !== 1) throw new Error(`mutant ${MUTANT}: edit for ${name} matched ${n} times (needs exactly 1): ${edit.from.slice(0, 60)}`)
    text = text.replace(edit.from, () => edit.to)
  }
  return text
}
/** In mutant mode: install the TEMP copies in this session. A no-op against the real functions. */
async function install(db: Client) {
  if (!MUTANT) return
  await db.query(functionSource('transition_order'))
  await db.query(functionSource('assign_courier'))
}

// ---------------------------------------------------------------------------------------------------------
// ids. 7a… = linhas de fixture (rollback). 7b… = a seção de concorrência (commit + limpeza).
const hex = (n: number) => n.toString(16).padStart(12, '0')
const u = (n: number) => `7a000000-0000-4000-8000-${hex(n)}`
const ID = {
  admin: u(1), blockedAdmin: u(2), clientA: u(3), clientB: u(4), merchant1: u(5), merchant2: u(6),
  courierQ1: u(7), courierQ2: u(8), courierA1: u(9), courierPending: u(10), fleetOwner: u(11), fleetUser: u(12),
  shop1: `7a100000-0000-4000-8000-${hex(1)}`, shop2: `7a100000-0000-4000-8000-${hex(2)}`,
  fleet1: `7a200000-0000-4000-8000-${hex(1)}`,
} as const

type Kind = 'food' | 'courier' | 'ride'
const STATUSES = [
  'criado', 'aguardando_loja', 'aguardando_motoboy', 'em_preparo', 'pronto', 'aceito', 'motoboy_chegou',
  'coletado', 'em_rota', 'em_viagem', 'entregue', 'finalizado', 'cancelado',
] as const
type Status = (typeof STATUSES)[number]

const FIXTURE = `
insert into auth.users (id, email) values
  ${Object.entries({ admin: 1, blockedAdmin: 2, clientA: 3, clientB: 4, merchant1: 5, merchant2: 6, courierQ1: 7, courierQ2: 8, courierA1: 9, courierPending: 10, fleetOwner: 11, fleetUser: 12 })
    .map(([k, n]) => `('${u(n)}', '${k.toLowerCase()}@transition-fixture.invalid')`).join(',\n  ')};
insert into public.profiles (id, role, full_name, status, home_city) values
  ('${ID.admin}', 'admin', 'Admin', 'active', 'quarai'),
  ('${ID.blockedAdmin}', 'admin', 'Admin bloqueado', 'blocked', 'quarai'),
  ('${ID.clientA}', 'client', 'Cliente A', 'active', 'quarai'),
  ('${ID.clientB}', 'client', 'Cliente B', 'active', 'quarai'),
  ('${ID.merchant1}', 'merchant', 'Dono 1', 'active', 'quarai'),
  ('${ID.merchant2}', 'merchant', 'Dono 2', 'active', 'artigas'),
  ('${ID.courierQ1}', 'courier', 'Motoboy Q1', 'active', 'quarai'),
  ('${ID.courierQ2}', 'courier', 'Motoboy Q2', 'active', 'quarai'),
  ('${ID.courierA1}', 'courier', 'Motoboy A1', 'active', 'artigas'),
  ('${ID.courierPending}', 'courier', 'Motoboy pendente', 'active', 'quarai'),
  ('${ID.fleetOwner}', 'fleet', 'Dono da frota', 'active', 'quarai'),
  ('${ID.fleetUser}', 'fleet', 'Outro da frota', 'active', 'quarai')
on conflict (id) do update set role = excluded.role, status = excluded.status, full_name = excluded.full_name;
insert into public.fleets (id, owner_id, name, city, status) values
  ('${ID.fleet1}', '${ID.fleetOwner}', 'Tele Quarai (fixture)', 'quarai', 'approved');
insert into public.couriers (profile_id, vehicle, base_city, fleet_id, status) values
  ('${ID.courierQ1}', 'moto', 'quarai', '${ID.fleet1}', 'approved'),
  ('${ID.courierQ2}', 'moto', 'quarai', null, 'approved'),
  ('${ID.courierA1}', 'moto', 'artigas', null, 'approved'),
  ('${ID.courierPending}', 'moto', 'quarai', null, 'pending');
insert into public.merchants (id, owner_id, name, kind, city, country, status, commission_pct) values
  ('${ID.shop1}', '${ID.merchant1}', 'Loja 1 (fixture)', 'restaurante', 'quarai', 'BR', 'approved', 10),
  ('${ID.shop2}', '${ID.merchant2}', 'Loja 2 (fixture)', 'restaurante', 'artigas', 'UY', 'approved', 10);
`

let db: Client
let seq = 0
const orderId = (n: number) => `7a300000-0000-4000-8000-${hex(n)}`

const addr = (city: string) => JSON.stringify({ city, street_name: 'Rua teste', number: '1' })

interface MkOrder {
  kind: Kind
  status: Status
  client?: string
  shop?: string | null
  courier?: string | null
  fleet?: string | null
  city?: 'quarai' | 'artigas'
}
/** Insert an order directly (create_order is another task's and may not exist). */
async function mkOrder(o: MkOrder): Promise<string> {
  await as('postgres')
  const id = orderId(++seq)
  const city = o.city ?? 'quarai'
  const shop = o.shop === undefined ? (o.kind === 'food' ? (city === 'quarai' ? ID.shop1 : ID.shop2) : null) : o.shop
  await db.query(
    `insert into public.orders (id, kind, client_id, merchant_id, courier_id, fleet_id, pickup_address, dropoff_address,
        status, total_brl, total_charged, payment_method)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $7::jsonb, $8, 20, 20, 'pix')`,
    [id, o.kind, o.client ?? ID.clientA, shop, o.courier ?? null, o.fleet ?? null, addr(city), o.status],
  )
  return id
}

/** Switch to a role the way PostgREST does per request; 'postgres' goes back to the owner. */
async function as(who: 'postgres' | string) {
  await db.query('reset role')
  if (who === 'postgres') {
    await db.query(`select set_config('request.jwt.claims', '', true)`)
    return
  }
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: who, role: 'authenticated' })])
  await db.query('set local role authenticated')
}
async function asAnon() {
  await db.query('reset role')
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'anon' })])
  await db.query('set local role anon')
}

type Attempt = { ok: true; rows: Record<string, unknown>[] } | { ok: false; code?: string; message: string }
async function attempt(sql: string, params: unknown[] = []): Promise<Attempt> {
  await db.query('savepoint probe')
  try {
    const r = await db.query(sql, params)
    await db.query('release savepoint probe')
    return { ok: true, rows: r.rows }
  } catch (e) {
    await db.query('rollback to savepoint probe')
    const err = e as { code?: string; message: string }
    return { ok: false, code: err.code, message: err.message }
  }
}
const move = async (who: string, id: string, to: Status, note: string | null = null) => {
  await as(who)
  return attempt(`select ${TRANSITION}($1, $2::public.order_status, $3)`, [id, to, note])
}
const assign = async (who: string, id: string, courier: string, note: string | null = 'despachado por telefone') => {
  await as(who)
  return attempt(`select ${ASSIGN}($1, $2, $3)`, [id, courier, note])
}
const refused = (r: Attempt, code: string, message: RegExp) => {
  expect(r.ok, 'the call was accepted but had to be refused').toBe(false)
  if (!r.ok) {
    expect(r.code, r.message).toBe(code)
    expect(r.message).toMatch(message)
  }
}
const accepted = (r: Attempt) => expect(r.ok, r.ok ? '' : `${r.code}: ${r.message}`).toBe(true)

interface OrderRow { status: string; courier_id: string | null; fleet_id: string | null; cancel_reason: string | null; cancelled_by: string | null
  cancelled_at: Date | null; accepted_at: Date | null; prepared_at: Date | null; picked_up_at: Date | null; delivered_at: Date | null; status_updated_at: Date }
const row = async (id: string) => {
  await as('postgres')
  return (await db.query<OrderRow>(`select * from public.orders where id = $1`, [id])).rows[0]
}
const events = async (id: string) => {
  await as('postgres')
  return (await db.query<{ from_status: string; to_status: string; actor_id: string | null; actor_role: string | null; note: string | null }>(
    `select from_status, to_status, actor_id, actor_role, note from public.order_events where order_id = $1 order by id`, [id])).rows
}

beforeAll(async () => {
  db = await connect()
  await install(db)
  await db.query('begin')
  await db.query(FIXTURE)
})
afterAll(async () => {
  try { await db.query('rollback') } finally { await db.end() }
})
beforeEach(async () => { await db.query('savepoint t') })
afterEach(async () => {
  await db.query('reset role').catch(() => undefined)
  await db.query('rollback to savepoint t')
})

// =========================================================================================================
describe('transition_order: o que a tabela permite e o que ela não permite', () => {
  test('transição listada em status_transitions para o papel é aceita, e o estado e os carimbos andam', async () => {
    const id = await mkOrder({ kind: 'food', status: 'criado' })
    accepted(await move(ID.clientA, id, 'aguardando_loja'))
    expect((await row(id)).status).toBe('aguardando_loja')

    accepted(await move(ID.merchant1, id, 'em_preparo'))
    accepted(await move(ID.merchant1, id, 'pronto'))
    const r = await row(id)
    expect(r.status).toBe('pronto')
    expect(r.prepared_at).not.toBeNull()
    expect(r.picked_up_at).toBeNull()
  })

  test('transição não listada é rejeitada e nada muda (nem estado, nem evento)', async () => {
    const id = await mkOrder({ kind: 'food', status: 'em_preparo' })
    const before = await row(id)
    // merchant pode em_preparo -> pronto; pular direto para entregue não está na tabela para ninguém
    refused(await move(ID.merchant1, id, 'entregue'), '55000', /not allowed/)
    // e uma transição que existe, mas para OUTRO papel, também não vale: courier não marca pronto
    refused(await move(ID.courierQ1, id, 'pronto'), '55000', /not allowed/)
    expect(await row(id)).toEqual(before)
    expect(await events(id)).toEqual([])
  })

  test('client tentando marcar entregue é rejeitado, inclusive no pedido dele', async () => {
    const id = await mkOrder({ kind: 'food', status: 'em_rota', courier: ID.courierQ1 })
    refused(await move(ID.clientA, id, 'entregue', 'cheguei'), '55000', /not allowed for role client/)
    expect((await row(id)).status).toBe('em_rota')
    expect((await row(id)).delivered_at).toBeNull()
  })

  test('transição em pedido de kind ride usa o subconjunto de ride', async () => {
    const ride = await mkOrder({ kind: 'ride', status: 'criado' })
    accepted(await move(ID.courierQ1, ride, 'aceito')) // o motoboy aceita a corrida da fila
    accepted(await move(ID.courierQ1, ride, 'motoboy_chegou'))
    accepted(await move(ID.courierQ1, ride, 'em_viagem'))
    // ride termina em finalizado, nunca em entregue
    refused(await move(ID.courierQ1, ride, 'entregue'), '55000', /not allowed/)
    accepted(await move(ID.courierQ1, ride, 'finalizado'))
    expect((await row(ride)).delivered_at).not.toBeNull()

    // a MESMA tripla (coletado -> em_rota, courier) existe em food e NÃO existe em courier
    const food = await mkOrder({ kind: 'food', status: 'coletado', courier: ID.courierQ1 })
    const parcel = await mkOrder({ kind: 'courier', status: 'coletado', courier: ID.courierQ1 })
    accepted(await move(ID.courierQ1, food, 'em_rota'))
    refused(await move(ID.courierQ1, parcel, 'em_rota'), '55000', /not allowed/)
    // e ride não tem preparo: merchant nunca mexe nele
    const ride2 = await mkOrder({ kind: 'ride', status: 'criado' })
    refused(await move(ID.merchant1, ride2, 'em_preparo'), '55000', /not allowed/)
  })
})

// =========================================================================================================
describe('transition_order: cancelamento', () => {
  const cancelFromByClient: [Kind, Status][] = [['food', 'criado'], ['food', 'aguardando_loja'], ['courier', 'criado'], ['courier', 'aguardando_motoboy'], ['ride', 'criado']]
  test.each(cancelFromByClient)('client cancela %s a partir de %s, e o motivo e o autor ficam gravados', async (kind, status) => {
    const id = await mkOrder({ kind, status })
    accepted(await move(ID.clientA, id, 'cancelado', 'mudei de ideia'))
    const r = await row(id)
    expect(r).toMatchObject({ status: 'cancelado', cancel_reason: 'mudei de ideia', cancelled_by: ID.clientA })
    expect(r.cancelled_at).not.toBeNull()
    expect(await events(id)).toEqual([{ from_status: status, to_status: 'cancelado', actor_id: ID.clientA, actor_role: 'client', note: 'mudei de ideia' }])
  })

  // depois que a cozinha começou, o cliente sozinho não decide mais. O motivo vai preenchido: a recusa tem de
  // ser por causa do ESTADO, não por falta de motivo.
  const clientLocked: [Kind, Status, Partial<MkOrder>][] = [
    ['food', 'em_preparo', {}], ['food', 'pronto', {}], ['food', 'coletado', { courier: ID.courierQ1 }], ['food', 'em_rota', { courier: ID.courierQ1 }],
    ['courier', 'aceito', { courier: ID.courierQ1 }], ['courier', 'coletado', { courier: ID.courierQ1 }],
    ['ride', 'aceito', { courier: ID.courierQ1 }], ['ride', 'motoboy_chegou', { courier: ID.courierQ1 }], ['ride', 'em_viagem', { courier: ID.courierQ1 }],
  ]
  test.each(clientLocked)('client NÃO cancela %s a partir de %s', async (kind, status, extra) => {
    const id = await mkOrder({ kind, status, ...extra })
    refused(await move(ID.clientA, id, 'cancelado', 'quero cancelar mesmo assim'), '55000', /not allowed for role client/)
    expect((await row(id)).status).toBe(status)
    expect(await events(id)).toEqual([])
  })

  test('merchant cancela de aguardando_loja, em_preparo e pronto, e de nenhum outro lugar', async () => {
    for (const status of ['aguardando_loja', 'em_preparo', 'pronto'] as const) {
      const id = await mkOrder({ kind: 'food', status })
      accepted(await move(ID.merchant1, id, 'cancelado', `sem estoque (${status})`))
      expect(await row(id)).toMatchObject({ status: 'cancelado', cancelled_by: ID.merchant1, cancel_reason: `sem estoque (${status})` })
    }
    for (const status of ['criado', 'coletado', 'em_rota'] as const) {
      const id = await mkOrder({ kind: 'food', status, courier: status === 'criado' ? null : ID.courierQ1 })
      refused(await move(ID.merchant1, id, 'cancelado', 'tarde demais'), '55000', /not allowed for role merchant/)
    }
  })

  test('cancelamento sem motivo é rejeitado para client, merchant e admin (nulo, vazio e só espaços)', async () => {
    for (const [who, kind, status] of [
      [ID.clientA, 'food', 'aguardando_loja'], [ID.merchant1, 'food', 'em_preparo'], [ID.admin, 'food', 'em_preparo'],
    ] as const) {
      const id = await mkOrder({ kind, status })
      for (const note of [null, '', '   ']) {
        refused(await move(who, id, 'cancelado', note), '22023', /reason/)
        expect((await row(id)).status).toBe(status)
      }
      expect(await events(id)).toEqual([])
      // controle: o MESMO pedido, o mesmo ator e a mesma transição passam quando há motivo. Sem isto, a
      // recusa acima poderia ser por qualquer outra causa.
      accepted(await move(who, id, 'cancelado', 'motivo real'))
    }
  })

  test('ninguém apaga pedido, nem o admin: o DELETE direto não remove a linha', async () => {
    const id = await mkOrder({ kind: 'food', status: 'cancelado' })
    for (const who of [ID.admin, ID.clientA, ID.merchant1]) {
      await as(who)
      const r = await attempt(`delete from public.orders where id = $1`, [id])
      if (r.ok) expect(r.rows).toEqual([]) // sem policy de DELETE o comando "passa" sem apagar nada
      await as('postgres')
      expect((await db.query(`select 1 from public.orders where id = $1`, [id])).rowCount, `${who} apagou o pedido`).toBe(1)
    }
  })
})

// =========================================================================================================
describe('transition_order: quem move, e o rastro', () => {
  test('toda transição grava order_events com ator e papel, para cada papel', async () => {
    const food = await mkOrder({ kind: 'food', status: 'criado' })
    accepted(await move(ID.clientA, food, 'aguardando_loja'))
    accepted(await move(ID.merchant1, food, 'em_preparo', 'pode fazer'))
    accepted(await move(ID.merchant1, food, 'pronto'))
    accepted(await move(ID.courierQ1, food, 'coletado')) // aceite da fila de comida
    accepted(await move(ID.admin, food, 'em_rota', 'motoboy avisou por rádio'))
    expect(await events(food)).toEqual([
      { from_status: 'criado', to_status: 'aguardando_loja', actor_id: ID.clientA, actor_role: 'client', note: null },
      { from_status: 'aguardando_loja', to_status: 'em_preparo', actor_id: ID.merchant1, actor_role: 'merchant', note: 'pode fazer' },
      { from_status: 'em_preparo', to_status: 'pronto', actor_id: ID.merchant1, actor_role: 'merchant', note: null },
      { from_status: 'pronto', to_status: 'coletado', actor_id: ID.courierQ1, actor_role: 'courier', note: null },
      { from_status: 'coletado', to_status: 'em_rota', actor_id: ID.admin, actor_role: 'admin', note: 'motoboy avisou por rádio' },
    ])
    const r = await row(food)
    expect(r.picked_up_at).not.toBeNull()
    expect(r.accepted_at).not.toBeNull()
  })

  test('a recusa não deixa rastro: nenhum evento, nenhuma mudança de updated_at', async () => {
    const id = await mkOrder({ kind: 'food', status: 'criado' })
    const before = await row(id)
    refused(await move(ID.clientA, id, 'entregue'), '55000', /not allowed/)
    expect(await row(id)).toEqual(before)
    expect(await events(id)).toEqual([])
  })

  test('client só move o PRÓPRIO pedido; merchant só o da PRÓPRIA loja', async () => {
    const mine = await mkOrder({ kind: 'food', status: 'aguardando_loja', client: ID.clientA })
    refused(await move(ID.clientB, mine, 'cancelado', 'não é meu'), '42501', /not allowed to move/)
    refused(await move(ID.merchant2, mine, 'em_preparo'), '42501', /not allowed to move/) // loja de Artigas
    accepted(await move(ID.merchant1, mine, 'em_preparo'))
    expect((await events(mine)).length).toBe(1)
  })

  test('papel sem linha na tabela (fleet), perfil bloqueado e anônimo não movem nada', async () => {
    const id = await mkOrder({ kind: 'food', status: 'criado' })
    refused(await move(ID.fleetOwner, id, 'cancelado', 'x'), '55000', /not allowed for role fleet/)
    // admin com perfil bloqueado perde o poder: app_role() devolve null
    refused(await move(ID.blockedAdmin, id, 'entregue', 'x'), '42501', /not allowed/)
    await asAnon()
    const r = await attempt(`select ${TRANSITION}($1, 'cancelado', 'x')`, [id])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('42501') // anon nem recebe EXECUTE
    expect((await row(id)).status).toBe('criado')
  })

  test('o courier só mexe no pedido atribuído a ele, e o aceite exige a cidade e o cadastro aprovado', async () => {
    const mine = await mkOrder({ kind: 'courier', status: 'aceito', courier: ID.courierQ1 })
    refused(await move(ID.courierQ2, mine, 'coletado'), '55000', /already has a courier/)
    accepted(await move(ID.courierQ1, mine, 'coletado'))

    const queue = await mkOrder({ kind: 'courier', status: 'aguardando_motoboy', city: 'quarai' })
    refused(await move(ID.courierA1, queue, 'aceito'), '42501', /city/) // motoboy de Artigas não pega a fila de Quaraí
    refused(await move(ID.courierPending, queue, 'aceito'), '42501', /city|approved/) // cadastro pendente
    refused(await move(ID.clientA, queue, 'aceito'), '55000', /not allowed for role client/)
    expect((await row(queue)).courier_id).toBeNull()
    accepted(await move(ID.courierQ2, queue, 'aceito'))
    expect((await row(queue)).courier_id).toBe(ID.courierQ2)
  })

  test('aceite copia o fleet_id do motoboy; motoboy autônomo deixa fleet_id nulo', async () => {
    const a = await mkOrder({ kind: 'courier', status: 'aguardando_motoboy' })
    accepted(await move(ID.courierQ1, a, 'aceito'))
    expect(await row(a)).toMatchObject({ courier_id: ID.courierQ1, fleet_id: ID.fleet1 })
    const b = await mkOrder({ kind: 'courier', status: 'aguardando_motoboy' })
    accepted(await move(ID.courierQ2, b, 'aceito'))
    expect(await row(b)).toMatchObject({ courier_id: ID.courierQ2, fleet_id: null })
  })

  test('direto no PostgREST ninguém move pedido: nem o admin faz UPDATE de status, courier_id ou fleet_id', async () => {
    const id = await mkOrder({ kind: 'courier', status: 'aguardando_motoboy' })
    for (const who of [ID.admin, ID.clientA, ID.courierQ1]) {
      for (const set of ["status = 'entregue'", `courier_id = '${ID.courierQ1}'`, `fleet_id = '${ID.fleet1}'`]) {
        await as(who)
        const r = await attempt(`update public.orders set ${set} where id = $1`, [id])
        // 42501: guarda de colunas (client/courier) ou o gatilho que só deixa a função mover (admin)
        const moved = r.ok && r.rows.length === 0 ? 'zero linhas (policy)' : r.ok ? 'ACEITO' : r.code
        expect(['42501', 'zero linhas (policy)'], `${who} / ${set}: ${moved}`).toContain(moved)
      }
    }
    expect(await row(id)).toMatchObject({ status: 'aguardando_motoboy', courier_id: null, fleet_id: null })
    expect(await events(id)).toEqual([])
    // e o que o admin PODE editar direto continua podendo (não é bloqueio geral)
    await as(ID.admin)
    accepted(await attempt(`update public.orders set client_notes = 'ligar antes' where id = $1`, [id]))
  })
})

// =========================================================================================================
describe('admin: qualquer transição, sempre com motivo e registro (o bypass mora na função, não na tabela)', () => {
  test('status_transitions continua SEM linhas de admin (o atalho é da função)', async () => {
    await as('postgres')
    const r = await db.query(`select count(*)::int as n from public.status_transitions where allowed_role = 'admin'`)
    expect(r.rows[0].n).toBe(0)
  })

  test('admin move de qualquer status para qualquer outro do fluxo, com motivo, e o evento leva o motivo', async () => {
    const id = await mkOrder({ kind: 'food', status: 'criado', courier: ID.courierQ1 })
    accepted(await move(ID.admin, id, 'entregue', 'cliente confirmou por telefone')) // salta o fluxo inteiro
    accepted(await move(ID.admin, id, 'em_preparo', 'foi engano, voltando')) // e volta de um estado final
    expect(await events(id)).toEqual([
      { from_status: 'criado', to_status: 'entregue', actor_id: ID.admin, actor_role: 'admin', note: 'cliente confirmou por telefone' },
      { from_status: 'entregue', to_status: 'em_preparo', actor_id: ID.admin, actor_role: 'admin', note: 'foi engano, voltando' },
    ])
  })

  test('admin sem motivo é recusado (nulo, vazio, espaços), em qualquer transição', async () => {
    const id = await mkOrder({ kind: 'food', status: 'aguardando_loja' })
    for (const note of [null, '', '  \t ']) {
      refused(await move(ID.admin, id, 'em_preparo', note), '22023', /reason/)
    }
    expect((await row(id)).status).toBe('aguardando_loja')
    expect(await events(id)).toEqual([])
    accepted(await move(ID.admin, id, 'em_preparo', 'a loja ligou'))
  })

  test('admin cancelando grava motivo e autor, e sair de cancelado limpa os campos mas o evento guarda tudo', async () => {
    const id = await mkOrder({ kind: 'courier', status: 'aguardando_motoboy' })
    accepted(await move(ID.admin, id, 'cancelado', 'cliente sumiu'))
    expect(await row(id)).toMatchObject({ status: 'cancelado', cancel_reason: 'cliente sumiu', cancelled_by: ID.admin })
    accepted(await move(ID.admin, id, 'criado', 'cancelado por engano'))
    expect(await row(id)).toMatchObject({ status: 'criado', cancel_reason: null, cancelled_by: null, cancelled_at: null })
    expect(await events(id)).toEqual([
      { from_status: 'aguardando_motoboy', to_status: 'cancelado', actor_id: ID.admin, actor_role: 'admin', note: 'cliente sumiu' },
      { from_status: 'cancelado', to_status: 'criado', actor_id: ID.admin, actor_role: 'admin', note: 'cancelado por engano' },
    ])
  })

  test('admin não ganha estado que não existe no fluxo do kind, nem "mover" para onde já está', async () => {
    const ride = await mkOrder({ kind: 'ride', status: 'criado' })
    refused(await move(ID.admin, ride, 'em_rota', 'x'), '55000', /not part of the ride flow/)
    refused(await move(ID.admin, ride, 'em_preparo', 'x'), '55000', /not part of the ride flow/)
    refused(await move(ID.admin, ride, 'criado', 'x'), '55000', /already/)
    const parcel = await mkOrder({ kind: 'courier', status: 'criado' })
    refused(await move(ID.admin, parcel, 'pronto', 'x'), '55000', /not part of the courier flow/)
    expect(await events(ride)).toEqual([])
  })

  test('admin não põe o pedido num estado de motoboy sem motoboy: atribua antes', async () => {
    const id = await mkOrder({ kind: 'courier', status: 'aguardando_motoboy' })
    refused(await move(ID.admin, id, 'aceito', 'x'), '55000', /needs a courier/)
    refused(await move(ID.admin, id, 'coletado', 'x'), '55000', /needs a courier/)
    refused(await move(ID.admin, id, 'entregue', 'x'), '55000', /needs a courier/)
    expect((await row(id)).status).toBe('aguardando_motoboy')
    // com motoboy atribuído, o mesmo salto passa
    accepted(await assign(ID.admin, id, ID.courierQ1))
    accepted(await move(ID.admin, id, 'entregue', 'entregue, motoboy confirmou'))
  })

  test('pedido inexistente: P0002, sem efeito', async () => {
    refused(await move(ID.admin, '7a999999-0000-4000-8000-000000000000', 'cancelado', 'x'), 'P0002', /not found/)
  })
})

// =========================================================================================================
describe('assign_courier: despacho manual', () => {
  test('atribuir motoboy copia fleet_id de couriers para o pedido e aceita a corrida da fila', async () => {
    const id = await mkOrder({ kind: 'courier', status: 'aguardando_motoboy' })
    accepted(await assign(ID.admin, id, ID.courierQ1, 'ligou para o Q1'))
    const r = await row(id)
    expect(r).toMatchObject({ status: 'aceito', courier_id: ID.courierQ1, fleet_id: ID.fleet1 })
    expect(r.accepted_at).not.toBeNull()
    const ev = await events(id)
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ from_status: 'aguardando_motoboy', to_status: 'aceito', actor_id: ID.admin, actor_role: 'admin' })
    // o evento diz QUEM foi atribuído: sem isso uma troca posterior apagaria o rastro do motoboy anterior
    expect(ev[0].note).toContain(ID.courierQ1)
    expect(ev[0].note).toContain('ligou para o Q1')
  })

  test('motoboy autônomo deixa fleet_id nulo, e trocar de motoboy limpa o fleet_id do anterior', async () => {
    const id = await mkOrder({ kind: 'courier', status: 'aguardando_motoboy' })
    accepted(await assign(ID.admin, id, ID.courierQ2))
    expect(await row(id)).toMatchObject({ courier_id: ID.courierQ2, fleet_id: null })

    // reatribuição de frota para autônomo: o fleet_id antigo NÃO pode sobrar (a taxa seria creditada à frota errada)
    const other = await mkOrder({ kind: 'courier', status: 'aceito', courier: ID.courierQ1, fleet: ID.fleet1 })
    accepted(await assign(ID.admin, other, ID.courierQ2, 'Q1 furou o pneu'))
    expect(await row(other)).toMatchObject({ courier_id: ID.courierQ2, fleet_id: null, status: 'aceito' })
    const ev = await events(other)
    expect(ev[0].note).toContain(ID.courierQ2)
  })

  test('ride: a atribuição também aceita; comida: atribui sem mudar o estado (o aceite é o coletado)', async () => {
    const ride = await mkOrder({ kind: 'ride', status: 'criado' })
    accepted(await assign(ID.admin, ride, ID.courierQ1))
    expect(await row(ride)).toMatchObject({ status: 'aceito', courier_id: ID.courierQ1 })

    const food = await mkOrder({ kind: 'food', status: 'em_preparo' })
    accepted(await assign(ID.admin, food, ID.courierQ2))
    expect(await row(food)).toMatchObject({ status: 'em_preparo', courier_id: ID.courierQ2, fleet_id: null })
    // atribuído, o pedido sai da fila: outro motoboy não o pega quando ficar pronto
    accepted(await move(ID.merchant1, food, 'pronto'))
    refused(await move(ID.courierQ1, food, 'coletado'), '55000', /already has a courier/)
    accepted(await move(ID.courierQ2, food, 'coletado'))
  })

  test('só o admin atribui; motoboy pendente, de outro perfil ou inexistente é recusado; pedido encerrado também', async () => {
    const id = await mkOrder({ kind: 'courier', status: 'aguardando_motoboy' })
    for (const who of [ID.clientA, ID.courierQ1, ID.merchant1, ID.fleetOwner, ID.blockedAdmin]) {
      refused(await assign(who, id, ID.courierQ1), '42501', /administrator/)
    }
    refused(await assign(ID.admin, id, ID.courierPending), 'P0002', /courier/)
    refused(await assign(ID.admin, id, ID.clientB), 'P0002', /courier/)
    refused(await assign(ID.admin, id, ID.courierQ1, '  '), '22023', /reason/)
    refused(await assign(ID.admin, id, ID.courierQ1, null), '22023', /reason/)
    expect(await row(id)).toMatchObject({ status: 'aguardando_motoboy', courier_id: null })
    expect(await events(id)).toEqual([])
    for (const status of ['entregue', 'cancelado'] as const) {
      const done = await mkOrder({ kind: 'courier', status })
      refused(await assign(ID.admin, done, ID.courierQ1), '55000', /closed|finished|already/)
    }
  })
})

// =========================================================================================================
describe('dispatch_couriers: o raio vem de private.effective_radius_km, nunca da coluna', () => {
  test('o raio mostrado ao despachante é o efetivo (o menor das três camadas)', async () => {
    await as('postgres')
    const global = Number((await db.query(`select value #>> '{}' as v from public.settings where key = 'service_radius_km'`)).rows[0].v)
    // a frota limita em 2 km; Q1 (frota) não escolheu raio; Q2 (autônomo) escolheu 3; A1 não escolheu
    await db.query(`update public.fleets set max_radius_km = 2 where id = $1`, [ID.fleet1])
    await db.query(`update public.couriers set work_radius_km = 3 where profile_id = $1`, [ID.courierQ2])
    await as(ID.admin)
    const r = await db.query<{ profile_id: string; effective_radius_km: string; fleet_id: string | null }>(
      `select * from public.dispatch_couriers(null) where profile_id = any($1::uuid[])`,
      [[ID.courierQ1, ID.courierQ2, ID.courierA1, ID.courierPending]],
    )
    const by = Object.fromEntries(r.rows.map((x) => [x.profile_id, Number(x.effective_radius_km)]))
    expect(by[ID.courierQ1]).toBe(Math.min(2, global))
    expect(by[ID.courierQ2]).toBe(Math.min(3, global))
    expect(by[ID.courierA1]).toBe(global)
    // pendente não é candidato a despacho
    expect(ID.courierPending in by).toBe(false)
    // por cidade
    const q = await db.query<{ profile_id: string }>(`select profile_id from public.dispatch_couriers('artigas') where profile_id = any($1::uuid[])`, [[ID.courierQ1, ID.courierA1]])
    expect(q.rows.map((x) => x.profile_id)).toEqual([ID.courierA1])
    // e o fleet_id vem junto
    expect(r.rows.find((x) => x.profile_id === ID.courierQ1)?.fleet_id).toBe(ID.fleet1)
    // igual à função privada, ponto a ponto
    await as('postgres')
    const direct = await db.query<{ e: string }>(`select private.effective_radius_km($1) as e`, [ID.courierQ1])
    expect(Number(direct.rows[0].e)).toBe(by[ID.courierQ1])
  })

  test('só o admin lista os motoboys do despacho', async () => {
    for (const who of [ID.clientA, ID.courierQ1, ID.merchant1, ID.fleetOwner, ID.blockedAdmin]) {
      await as(who)
      const r = await attempt(`select * from public.dispatch_couriers(null)`)
      expect(r.ok, who).toBe(false)
      if (!r.ok) expect(r.code).toBe('42501')
    }
    await asAnon()
    const a = await attempt(`select * from public.dispatch_couriers(null)`)
    expect(a.ok).toBe(false)
  })
})

// =========================================================================================================
describe('o console só mostra botão que o banco aceita (legalTargets == o que transition_order aceita)', () => {
  /**
   * Para cada kind e cada status, cria o pedido na forma em que o papel o veria e pergunta ao BANCO, uma
   * transição por vez (cada tentativa desfeita), quais destinos ele aceita. O conjunto tem de ser exatamente o
   * que legalTargets() mostra. Uma função temporária faz as 13 tentativas no servidor, numa ida só.
   */
  const COURIER_STATES: Status[] = ['aceito', 'motoboy_chegou', 'coletado', 'em_rota', 'em_viagem', 'entregue', 'finalizado']
  let rows: TransitionRow[]

  beforeAll(async () => {
    await db.query('savepoint matrix_setup')
    await as('postgres')
    rows = (await db.query<TransitionRow>(`select kind, from_status, to_status, allowed_role from public.status_transitions`)).rows
    await db.query(`
      create or replace function pg_temp.accepted_targets(p_order uuid, p_uid uuid) returns text[]
      language plpgsql as $f$
      declare s public.order_status; r text[] := '{}';
      begin
        perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
        foreach s in array enum_range(null::public.order_status) loop
          begin
            perform ${TRANSITION}(p_order, s, 'matrix probe');
            r := r || s::text;
            raise exception using errcode = 'P9999', message = 'undo the probe';
          exception when others then
            null; -- a refusal (the common case) and the deliberate undo look the same here: both leave r as is
          end;
        end loop;
        return r;
      end
      $f$`)
    await db.query('release savepoint matrix_setup')
  })

  const flow = (kind: Kind) => STATUSES.filter((s) => rows.some((r) => r.kind === kind && (r.from_status === s || r.to_status === s)))

  test('para client, merchant e courier, em todo estado de todo kind', async () => {
    let probes = 0
    for (const kind of ['food', 'courier', 'ride'] as const) {
      for (const status of flow(kind)) {
        const needsCourier = COURIER_STATES.includes(status)
        for (const role of ['client', 'merchant', 'courier'] as const) {
          const actor = role === 'client' ? ID.clientA : role === 'merchant' ? ID.merchant1 : ID.courierQ1
          const id = await mkOrder({ kind, status, courier: needsCourier ? ID.courierQ1 : null })
          const shown = legalTargets(rows, { kind, status, courier_id: needsCourier ? ID.courierQ1 : null }, role).all
          await as('postgres')
          const ok = (await db.query<{ t: string[] }>(`select pg_temp.accepted_targets($1, $2) as t`, [id, actor])).rows[0].t
          expect([...shown].sort(), `${role} em ${kind}/${status}`).toEqual([...ok].sort())
          probes++
        }
      }
    }
    // 3 papéis x todos os estados dos 3 fluxos (food 7 + cancelado, courier 5, ride 5...): o laço não pode ficar vazio
    const expected = (['food', 'courier', 'ride'] as const).reduce((n, k) => n + flow(k).length * 3, 0)
    expect(expected).toBeGreaterThanOrEqual(45)
    expect(probes).toBe(expected)
  })

  test('para o admin, com e sem motoboy atribuído, em todo estado de todo kind', async () => {
    for (const kind of ['food', 'courier', 'ride'] as const) {
      for (const status of flow(kind)) {
        for (const withCourier of [false, true]) {
          const courier = withCourier ? ID.courierQ1 : null
          const id = await mkOrder({ kind, status, courier })
          const shown = legalTargets(rows, { kind, status, courier_id: courier }, 'admin').all
          await as('postgres')
          const ok = (await db.query<{ t: string[] }>(`select pg_temp.accepted_targets($1, $2) as t`, [id, ID.admin])).rows[0].t
          expect([...shown].sort(), `admin em ${kind}/${status} courier=${withCourier}`).toEqual([...ok].sort())
        }
      }
    }
  })

  test('valores esperados à mão (a comparação acima sozinha não pegaria os dois lados errados juntos)', () => {
    const t = (kind: Kind, status: Status, role: 'client' | 'merchant' | 'courier' | 'admin', courier: string | null = null) =>
      legalTargets(rows, { kind, status, courier_id: courier }, role)
    expect(t('food', 'em_preparo', 'merchant').all.sort()).toEqual(['cancelado', 'pronto'])
    expect(t('food', 'em_preparo', 'client').all).toEqual([]) // a cozinha já começou
    expect(t('food', 'aguardando_loja', 'client').all).toEqual(['cancelado'])
    expect(t('ride', 'em_viagem', 'courier', ID.courierQ1).all).toEqual(['finalizado'])
    // admin: o "próximo passo" são as transições do fluxo, o resto é ajuste manual; sem motoboy, nada de estado de motoboy
    const a = t('courier', 'aguardando_motoboy', 'admin')
    expect(a.next).toEqual(['cancelado']) // 'aceito' exige motoboy: o caminho é atribuir
    expect(a.all).not.toContain('aceito')
    expect(a.all).not.toContain('pronto') // 'pronto' não existe no fluxo courier
    expect(a.all).not.toContain('aguardando_motoboy') // o estado atual
    expect(a.other).toEqual(expect.arrayContaining(['criado']))
    const b = t('courier', 'aguardando_motoboy', 'admin', ID.courierQ1)
    expect(b.next.sort()).toEqual(['aceito', 'cancelado'])
  })
})

// =========================================================================================================
describe('Server Actions repetem uma vez no deadlock 40P01', () => {
  const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' })

  test('40P01 na primeira tentativa: repete uma vez e devolve o sucesso, sem expor o erro ao operador', async () => {
    const fn = vi.fn().mockRejectedValueOnce(deadlock()).mockResolvedValueOnce('ok')
    await expect(withDeadlockRetry(fn)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })
  test('erro retornado como valor (supabase-js devolve { error }) também é reconhecido', async () => {
    const fn = vi.fn().mockResolvedValueOnce({ error: { code: '40P01', message: 'deadlock detected' } }).mockResolvedValueOnce({ error: null })
    await expect(withDeadlockRetry(fn)).resolves.toEqual({ error: null })
    expect(fn).toHaveBeenCalledTimes(2)
  })
  test('só UMA repetição: o segundo 40P01 aparece', async () => {
    const fn = vi.fn().mockRejectedValue(deadlock())
    await expect(withDeadlockRetry(fn)).rejects.toMatchObject({ code: '40P01' })
    expect(fn).toHaveBeenCalledTimes(2)
  })
  test('outros erros não são repetidos (uma transição recusada não pode ser tentada de novo)', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('not allowed'), { code: '55000' }))
    await expect(withDeadlockRetry(fn)).rejects.toMatchObject({ code: '55000' })
    expect(fn).toHaveBeenCalledTimes(1)
    const g = vi.fn().mockResolvedValue({ error: { code: '42501', message: 'x' } })
    await expect(withDeadlockRetry(g)).resolves.toEqual({ error: { code: '42501', message: 'x' } })
    expect(g).toHaveBeenCalledTimes(1)
  })
})

// =========================================================================================================
// CONCORRÊNCIA. Precisa de duas conexões vivas: não cabe no begin/rollback único. Cria linhas commitadas sob o
// prefixo 7b… e apaga exatamente elas (antes, caso uma execução anterior tenha morrido no meio, e depois).
// A interleavação é FORÇADA, não esperada: a segunda instrução é vista esperando um lock em pg_stat_activity antes
// de a primeira ser liberada.
const r = (n: number) => `7b000000-0000-4000-8000-${hex(n)}`
const RACE = {
  client: r(1), courier1: r(2), courier2: r(3), admin: r(4), fleetOwner: r(5), fleet: `7b200000-0000-4000-8000-${hex(1)}`,
  orders: [1, 2, 3, 4, 5].map((n) => `7b300000-0000-4000-8000-${hex(n)}`),
}
const RACE_USERS = [RACE.client, RACE.courier1, RACE.courier2, RACE.admin, RACE.fleetOwner]

describe('aceite atômico: dois aceites simultâneos deixam o pedido com UM só motoboy', () => {
  let admin: Client // autocommit: preparo, observação e limpeza
  let one: Client
  let two: Client

  const cleanup = async () => {
    await admin.query(`delete from public.order_events where order_id = any($1::uuid[])`, [RACE.orders])
    await admin.query(`delete from public.orders where id = any($1::uuid[])`, [RACE.orders])
    await admin.query(`delete from public.courier_events where courier_id = any($1::uuid[])`, [RACE_USERS])
    await admin.query(`delete from public.couriers where profile_id = any($1::uuid[])`, [RACE_USERS])
    await admin.query(`delete from public.fleets where id = $1`, [RACE.fleet])
    await admin.query(`delete from public.audit_log where record_id = any($1::text[])`, [[...RACE_USERS, RACE.fleet, ...RACE.orders]])
    await admin.query(`delete from public.profiles where id = any($1::uuid[])`, [RACE_USERS])
    await admin.query(`delete from public.audit_log where record_id = any($1::text[])`, [RACE_USERS])
    await admin.query(`delete from auth.users where id = any($1::uuid[])`, [RACE_USERS])
  }
  const orderRows = (status: string, kind: string, n: number) =>
    `('${RACE.orders[n]}', '${kind}', '${RACE.client}', null, '${addr('quarai')}'::jsonb, '${addr('quarai')}'::jsonb, '${status}', 20, 20, 'pix')`

  beforeAll(async () => {
    admin = await connect()
    one = await connect()
    two = await connect()
    await cleanup()
    await admin.query(
      `insert into auth.users (id, email) values ${RACE_USERS.map((x, i) => `('${x}', 'race${i}@transition.invalid')`).join(', ')};
       insert into public.profiles (id, role, full_name, status, home_city) values
         ('${RACE.client}', 'client', 'Cliente corrida', 'active', 'quarai'),
         ('${RACE.courier1}', 'courier', 'Motoboy 1', 'active', 'quarai'),
         ('${RACE.courier2}', 'courier', 'Motoboy 2', 'active', 'quarai'),
         ('${RACE.admin}', 'admin', 'Admin corrida', 'active', 'quarai'),
         ('${RACE.fleetOwner}', 'fleet', 'Dono corrida', 'active', 'quarai')
       on conflict (id) do update set role = excluded.role, status = excluded.status;
       insert into public.fleets (id, owner_id, name, city, status) values ('${RACE.fleet}', '${RACE.fleetOwner}', 'Frota corrida', 'quarai', 'approved');
       insert into public.couriers (profile_id, vehicle, base_city, fleet_id, status) values
         ('${RACE.courier1}', 'moto', 'quarai', '${RACE.fleet}', 'approved'),
         ('${RACE.courier2}', 'moto', 'quarai', null, 'approved');
       insert into public.orders (id, kind, client_id, merchant_id, pickup_address, dropoff_address, status, total_brl, total_charged, payment_method) values
         ${orderRows('aguardando_motoboy', 'courier', 0)},
         ${orderRows('aguardando_motoboy', 'courier', 1)},
         ${orderRows('criado', 'ride', 2)},
         ${orderRows('aguardando_motoboy', 'courier', 3)};`,
    )
    await install(one)
    await install(two)
  })
  afterAll(async () => {
    try {
      await one.query('rollback').catch(() => undefined)
      await two.query('rollback').catch(() => undefined)
      await cleanup()
    } finally {
      await Promise.all([admin.end(), one.end(), two.end()])
    }
  })

  // a failed test must not leave a transaction open (and aborted) on the shared connections
  beforeEach(async () => {
    await one.query('rollback').catch(() => undefined)
    await two.query('rollback').catch(() => undefined)
  })

  const as2 = async (c: Client, who: string) => {
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: who, role: 'authenticated' })])
    await c.query('set local role authenticated')
  }
  const pidOf = async (c: Client) => (await c.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0].pid
  // The pid is read BEFORE the statement starts: a pg client queues its queries, so asking the blocked client
  // for it afterwards would wait behind the very statement being observed.
  const waitUntilBlocked = async (pid: number) => {
    for (let i = 0; i < 100; i++) {
      const w = await admin.query(`select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`, [pid])
      if (w.rowCount) return
      await new Promise((res) => setTimeout(res, 100))
    }
    throw new Error('the second statement never blocked: the interleaving this test needs did not happen')
  }
  const start = (c: Client, sql: string, params: unknown[]) =>
    c.query(sql, params).then(
      () => ({ ok: true as const }),
      (e: { code?: string; message: string }) => ({ ok: false as const, code: e.code, message: e.message }),
    )
  const final = async (n: number) => ({
    order: (await admin.query<{ status: string; courier_id: string | null; fleet_id: string | null }>(`select status, courier_id, fleet_id from public.orders where id = $1`, [RACE.orders[n]])).rows[0],
    accepts: (await admin.query<{ actor_id: string }>(`select actor_id from public.order_events where order_id = $1 and to_status in ('aceito', 'coletado') order by id`, [RACE.orders[n]])).rows,
  })

  test('motoboy 1 aceita (ainda sem commit); o motoboy 2 espera o lock e é recusado; o pedido fica com o 1', async () => {
    await one.query('begin')
    await as2(one, RACE.courier1)
    await one.query(`select ${TRANSITION}($1, 'aceito', null)`, [RACE.orders[0]]) // vence, mas ainda não commitou: segura a linha

    await two.query('begin')
    await as2(two, RACE.courier2)
    const pid = await pidOf(two)
    const second = start(two, `select ${TRANSITION}($1, 'aceito', null)`, [RACE.orders[0]])
    await waitUntilBlocked(pid) // sem FOR UPDATE ele leria o estado antigo e só travaria no UPDATE; o resultado seria outro
    await one.query('commit')
    const res = await second
    await two.query('rollback')

    expect(res.ok, 'o segundo aceite foi aceito: dois motoboys venceram').toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('55000')
      expect(res.message).toMatch(/already has a courier/)
    }
    const f = await final(0)
    expect(f.order).toEqual({ status: 'aceito', courier_id: RACE.courier1, fleet_id: RACE.fleet })
    expect(f.accepts.map((x) => x.actor_id)).toEqual([RACE.courier1]) // um único evento de aceite
  })

  test('na ordem inversa o motoboy 2 (autônomo) vence e o 1 é recusado: fleet_id fica nulo', async () => {
    await two.query('begin')
    await as2(two, RACE.courier2)
    await two.query(`select ${TRANSITION}($1, 'aceito', null)`, [RACE.orders[1]])

    await one.query('begin')
    await as2(one, RACE.courier1)
    const pid = await pidOf(one)
    const second = start(one, `select ${TRANSITION}($1, 'aceito', null)`, [RACE.orders[1]])
    await waitUntilBlocked(pid)
    await two.query('commit')
    const res = await second
    await one.query('rollback')

    expect(res.ok).toBe(false)
    const f = await final(1)
    expect(f.order).toEqual({ status: 'aceito', courier_id: RACE.courier2, fleet_id: null })
    expect(f.accepts.map((x) => x.actor_id)).toEqual([RACE.courier2])
  })

  test('corrida (ride): mesma garantia na fila de ride/criado', async () => {
    await one.query('begin')
    await as2(one, RACE.courier1)
    await one.query(`select ${TRANSITION}($1, 'aceito', null)`, [RACE.orders[2]])
    await two.query('begin')
    await as2(two, RACE.courier2)
    const pid = await pidOf(two)
    const second = start(two, `select ${TRANSITION}($1, 'aceito', null)`, [RACE.orders[2]])
    await waitUntilBlocked(pid)
    await one.query('commit')
    const res = await second
    await two.query('rollback')
    expect(res.ok).toBe(false)
    expect((await final(2)).order.courier_id).toBe(RACE.courier1)
  })

  test('o admin atribui (ainda sem commit) e o motoboy tenta aceitar o mesmo pedido: espera e é recusado; o motoboy do admin fica', async () => {
    await one.query('begin')
    await as2(one, RACE.admin)
    await one.query(`select ${ASSIGN}($1, $2, 'despacho por rádio')`, [RACE.orders[3], RACE.courier2])
    await two.query('begin')
    await as2(two, RACE.courier1)
    const pid = await pidOf(two)
    const second = start(two, `select ${TRANSITION}($1, 'aceito', null)`, [RACE.orders[3]])
    await waitUntilBlocked(pid)
    await one.query('commit')
    const res = await second
    await two.query('rollback')
    expect(res.ok).toBe(false)
    const f = await final(3)
    expect(f.order).toMatchObject({ status: 'aceito', courier_id: RACE.courier2, fleet_id: null })
  })
})
