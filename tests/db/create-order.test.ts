import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { connect } from '../../scripts/db/client'
import { actAs, attempt } from './rls-helpers'

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 })

/**
 * create_order: o momento em que preço vira compromisso.
 *
 * Fixtures. Banco compartilhado e histórico protegido: pricing_rules e fx_rates rejeitam UPDATE e DELETE
 * (exceto fechar uma versão com valid_to). Então:
 *   - todo teste roda numa transação que SEMPRE sofre rollback;
 *   - nunca editamos uma regra: FECHAMOS a versão em vigor no dia de hoje (relógio de Quaraí) e INSERIMOS uma
 *     nova a partir de hoje, com preços fixos e sem adicional noturno, para o total não depender da hora em que
 *     o teste roda. O mesmo vale para o horário de serviço (aberto 24 h, salvo nos testes que o fecham) e para o
 *     câmbio (uma linha manual de hoje, 7.00 + 5% = 7.35);
 *   - lojas, cardápio, clientes e zonas são inseridos na transação, nunca lidos do que existir no banco.
 *
 * create_order usa o instante do servidor (now()); não existe parâmetro de relógio para o teste burlar.
 *
 * Mutação: com CREATE_ORDER_MUTANT_SQL=<arquivo> o teste NÃO chama public.create_order. Dentro da própria
 * transação (sempre revertida) instala o SQL do arquivo (uma cópia com defeito, em pg_temp) e chama a cópia.
 * A função viva nunca é tocada.
 */

const MUTANT_SQL = process.env.CREATE_ORDER_MUTANT_SQL
let db: Client
const FN = MUTANT_SQL ? 'pg_temp.create_order_mutant' : 'public.create_order'

beforeAll(async () => {
  db = await connect()
})
afterAll(async () => {
  await db.end()
})
beforeEach(async () => {
  await db.query('begin')
  if (MUTANT_SQL) await db.query(readFileSync(MUTANT_SQL, 'utf8'))
  await db.query(BASE_SETUP)
})
afterEach(async () => {
  await db.query('rollback')
})

const TODAY = `(now() at time zone 'America/Sao_Paulo')::date`
const OPEN_ALL_DAY = `'{"opens":"00:00","closes":"00:00"}'::jsonb`

/** Horário 24 h nas duas cidades, regra de preço fixa a partir de hoje, câmbio manual de hoje. */
const BASE_SETUP = `
update public.settings set value = jsonb_build_object(
  'quarai', jsonb_build_object('timezone', 'America/Sao_Paulo', 'delivery', ${OPEN_ALL_DAY}, 'courier', ${OPEN_ALL_DAY}, 'ride', ${OPEN_ALL_DAY}),
  'artigas', jsonb_build_object('timezone', 'America/Montevideo', 'delivery', ${OPEN_ALL_DAY}, 'courier', ${OPEN_ALL_DAY}, 'ride', ${OPEN_ALL_DAY})
) where key = 'service_hours';

update public.pricing_rules set valid_to = ${TODAY} where valid_to is null and valid_from < ${TODAY};
insert into public.pricing_rules (city, kind, base_fare_brl, included_km, per_km_brl, min_fare_brl,
  night_surcharge_brl, cross_border_fee_brl, passenger_cross_border_fee_brl, valid_from)
select c.city, k.kind, 10, 2, 2.5, 10, 0, 8, 12, ${TODAY}
from (values ('quarai'), ('artigas')) as c (city)
cross join (values ('delivery'::public.order_kind), ('courier'), ('ride')) as k (kind);

insert into public.fx_rates (rate, source, spread_pct, is_manual_override, valid_for_date)
values (7, 'manual', 5, true, ${TODAY});

-- os testes criam pedidos idênticos em sequência de propósito: a guarda de toque duplo fica desligada aqui
insert into public.settings (key, value) values ('orders.duplicate_window_seconds', '0')
on conflict (key) do update set value = '0';
`

// --- pontos ----------------------------------------------------------------------------------------------
type Pt = { city: string; country: string; lat: number; lng: number }
const Q1: Pt = { city: 'quarai', country: 'BR', lat: -30.3791, lng: -56.4514 }
const Q2: Pt = { city: 'quarai', country: 'BR', lat: -30.385, lng: -56.448 }
const Z: Pt = { city: 'quarai', country: 'BR', lat: -30.392, lng: -56.46 } // longe de Q1 e Q2
// perto da ponte, a ~0,5 km de Q1: create_order recusa distância abaixo da linha reta entre as pontas
const A1: Pt = { city: 'artigas', country: 'UY', lat: -30.3835, lng: -56.456 }

// --- a chamada -------------------------------------------------------------------------------------------
type Args = {
  client: string
  kind?: 'delivery' | 'courier' | 'ride'
  pickup?: Record<string, unknown> | null
  dropoff?: Record<string, unknown>
  merchant?: string | null
  items?: unknown
  pay?: 'dinheiro_brl' | 'dinheiro_uyu' | 'pix'
  changeFor?: number | string | null
  /** O que o cliente "viu". Omitido: pergunta ao próprio quote_order (um cliente honesto). */
  totalBrl?: number | string | null
  totalUyu?: number | string | null
  distance?: number | null
  source?: 'osrm' | 'haversine'
  notes?: string | null
}

const kindOf = (a: Args) => a.kind ?? 'courier'
const pickupOf = (a: Args) => (a.pickup === undefined ? (kindOf(a) === 'delivery' ? null : Q1) : a.pickup)
const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v))

/** O preço que o servidor cobraria agora (mesma transação, mesmo now()). */
async function serverQuote(a: Args) {
  const r = await db.query<{ q: Record<string, unknown> }>(
    `select public.quote_order($1::public.order_kind, $2::jsonb, $3::jsonb, $4::uuid, $5::jsonb, now(), $6::integer, $7::public.route_source) as q`,
    [kindOf(a), json(pickupOf(a)), json(a.dropoff ?? Q2), a.merchant ?? null, json(a.items), a.distance ?? 1500, a.source ?? 'osrm'],
  )
  return r.rows[0].q as { totalBrl: number; totalUyu: number; commissionBrl: number; breakdown: { key: string; amountBrl: number }[] }
}

async function params(a: Args) {
  const needsHonest = a.totalBrl === undefined || (a.pay === 'dinheiro_uyu' && a.totalUyu === undefined)
  const honest = needsHonest ? await serverQuote(a) : null
  return [
    a.client,
    kindOf(a),
    json(pickupOf(a)),
    json(a.dropoff ?? Q2),
    a.merchant ?? null,
    json(a.items),
    a.pay ?? 'pix',
    a.changeFor === undefined ? null : a.changeFor,
    a.totalBrl === undefined ? honest!.totalBrl : a.totalBrl,
    a.totalUyu === undefined ? (honest ? honest.totalUyu : null) : a.totalUyu,
    a.distance === undefined ? 1500 : a.distance,
    a.source ?? 'osrm',
    a.notes === undefined ? null : a.notes,
  ]
}

const CALL = `select ${FN}($1::uuid, $2::public.order_kind, $3::jsonb, $4::jsonb, $5::uuid, $6::jsonb, $7::public.payment_method,
  $8::numeric, $9::numeric, $10::numeric, $11::integer, $12::public.route_source, $13::text) as r`

type Created = { ok: true; orderId: string; code: string; status: string; totalBrl: number; currencyCharged: string; totalCharged: number }
type Rejected = { ok: false; code: string; totalBrl: number; totalUyu: number }

/** Um pedido que deve ser criado. */
async function create(a: Args): Promise<Created> {
  const r = await db.query<{ r: Created | Rejected }>(CALL, await params(a))
  const out = r.rows[0].r
  expect(out.ok, `deveria ter criado: ${JSON.stringify(out)}`).toBe(true)
  return out as Created
}
/** Um pedido recusado por RAISE: devolve o SQLSTATE e a mensagem. */
async function refused(a: Args) {
  const r = await attempt(db, CALL, await params(a))
  expect(r.ok, 'a chamada deveria ter levantado exceção').toBe(false)
  return r as { ok: false; code?: string; message: string }
}
/** Uma recusa por divergência de preço: volta como resultado (não levanta), porque o audit_log tem de ficar. */
async function mismatched(a: Args) {
  const r = await attempt(db, CALL, await params(a))
  expect(r.ok, 'a divergência não levanta: devolve a recusa').toBe(true)
  const out = (r as { ok: true; rows: { r: Created | Rejected }[] }).rows[0].r
  expect(out.ok).toBe(false)
  return out as Rejected
}

// --- fixtures de banco -----------------------------------------------------------------------------------
async function mkProfile(role = 'client', status = 'active'): Promise<string> {
  const id = randomUUID()
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${id}@create-order-fixture.invalid`])
  // o gatilho de sign-up (0023) já cria o perfil, quando aplicado; sem ele, o insert cria
  await db.query(
    `insert into public.profiles (id, role, status) values ($1, $2::public.user_role, $3)
     on conflict (id) do update set role = excluded.role, status = excluded.status`,
    [id, role, status],
  )
  return id
}

async function merchant(
  o: { city?: string; country?: string; commission?: number; cross?: boolean; status?: string; manual?: boolean; hours?: boolean; at?: Pt } = {},
) {
  const at = o.at ?? Q1
  const m = (
    await db.query<{ id: string }>(
      `insert into public.merchants (name, kind, city, country, lat, lng, commission_pct, accepts_cross_border, status, is_open_manual)
       values ('Loja de teste', 'loja', $1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [o.city ?? 'quarai', o.country ?? 'BR', at.lat, at.lng, o.commission ?? 12.5, o.cross ?? false, o.status ?? 'approved', o.manual ?? true],
    )
  ).rows[0].id
  if (o.hours !== false) {
    // opens_at = closes_at é uma faixa de 24 h (a mesma convenção de service_hours)
    await db.query(
      `insert into public.merchant_hours (merchant_id, weekday, opens_at, closes_at)
       select $1, d, '00:00', '00:00' from generate_series(0, 6) d`,
      [m],
    )
  }
  return m
}
const item = async (m: string, name: string, price: number, available = true) =>
  (await db.query<{ id: string }>(
    `insert into public.catalog_items (merchant_id, name, price_brl, is_available) values ($1, $2, $3, $4) returning id`,
    [m, name, price, available],
  )).rows[0].id
const group = async (it: string, name: string, min: number, max: number, required = false) =>
  (await db.query<{ id: string }>(
    `insert into public.item_option_groups (item_id, name, min_select, max_select, is_required) values ($1, $2, $3, $4, $5) returning id`,
    [it, name, min, max, required],
  )).rows[0].id
const option = async (g: string, name: string, delta: number, available = true) =>
  (await db.query<{ id: string }>(
    `insert into public.item_options (group_id, name, price_delta_brl, is_available) values ($1, $2, $3, $4) returning id`,
    [g, name, delta, available],
  )).rows[0].id

/** Loja de 12,5% (aberta, Quaraí) com hambúrguer (tamanho obrigatório + extras) e refrigerante. */
async function shop(o: Parameters<typeof merchant>[0] = {}) {
  const m = await merchant(o)
  const burger = await item(m, 'Hambúrguer', 25.9)
  const size = await group(burger, 'Tamanho', 0, 1, true)
  const small = await option(size, 'Pequeno', 0)
  const large = await option(size, 'Grande', 4.1)
  const extras = await group(burger, 'Extras', 0, 2)
  const bacon = await option(extras, 'Bacon', 3)
  const soda = await item(m, 'Refrigerante', 8)
  return { m, burger, soda, small, large, bacon, size, extras }
}
/** Hambúrguer grande com bacon × 2 (66.00) + refrigerante (8.00) = 74.00 de itens. */
const basket = (s: Awaited<ReturnType<typeof shop>>) => [
  { itemId: s.burger, qty: 2, optionIds: [s.large, s.bacon] },
  { itemId: s.soda, qty: 1 },
]

type Counts = { orders: number; items: number; events: number; commissions: number }
async function counts(client: string): Promise<Counts> {
  const r = await db.query<Counts>(
    `select (select count(*)::int from public.orders where client_id = $1) as orders,
            (select count(*)::int from public.order_items oi join public.orders o on o.id = oi.order_id where o.client_id = $1) as items,
            (select count(*)::int from public.order_events e join public.orders o on o.id = e.order_id where o.client_id = $1) as events,
            (select count(*)::int from public.order_commissions c join public.orders o on o.id = c.order_id where o.client_id = $1) as commissions`,
    [client],
  )
  return r.rows[0]
}
const NOTHING: Counts = { orders: 0, items: 0, events: 0, commissions: 0 }

const square = (c: { lat: number; lng: number }, half = 0.002) => ({
  type: 'Polygon',
  coordinates: [[
    [c.lng - half, c.lat - half], [c.lng + half, c.lat - half], [c.lng + half, c.lat + half],
    [c.lng - half, c.lat + half], [c.lng - half, c.lat - half],
  ]],
})

const orderRow = async (id: string) =>
  (await db.query(`select * from public.orders where id = $1`, [id])).rows[0] as Record<string, unknown>

/** Fecha o serviço agora: a janela de cada kind da cidade começa daqui a 1 h e dura 1 h (nunca contém agora). */
async function closeServiceNow(city: string) {
  await db.query(
    `update public.settings set value = jsonb_set(value, array[$1], (value -> $1) || (
       select jsonb_build_object(
         'delivery', w, 'courier', w, 'ride', w)
       from (select jsonb_build_object(
         'opens', to_char((now() at time zone (value -> $1 ->> 'timezone')) + interval '1 hour', 'HH24:MI'),
         'closes', to_char((now() at time zone (value -> $1 ->> 'timezone')) + interval '2 hours', 'HH24:MI')) as w) x
     )) where key = 'service_hours'`,
    [city],
  )
}

// ===========================================================================================================
describe('o pedido congela o preço', () => {
  test('grava pricing_breakdown, pricing_rule_id, fx_rate_used, distância e total congelados', async () => {
    const client = await mkProfile()
    const s = await shop()
    const rule = (await db.query<{ id: string }>(`select id from public.pricing_rules where city = 'quarai' and kind = 'delivery' and valid_to is null`)).rows[0].id
    const fx = (await db.query<{ id: string }>(`select id from public.fx_rates where valid_for_date = ${TODAY} and is_manual_override`)).rows[0].id

    const out = await create({ client, kind: 'delivery', merchant: s.m, items: basket(s), totalBrl: 84, distance: 1500 })
    expect(out).toMatchObject({ ok: true, status: 'criado', totalBrl: 84, currencyCharged: 'BRL', totalCharged: 84 })

    const o = await orderRow(out.orderId)
    expect(o.kind).toBe('delivery')
    expect(o.client_id).toBe(client)
    expect(o.merchant_id).toBe(s.m)
    expect(o.status).toBe('criado')
    expect(o.total_brl).toBe('84.00')
    expect(o.total_charged).toBe('84.00')
    expect(o.currency_charged).toBe('BRL')
    expect(o.pricing_rule_id).toBe(rule)
    expect(o.fx_rate_id).toBe(fx)
    expect(o.fx_rate_used).toBe('7.350000') // 7.00 + 5% de spread
    expect(o.distance_m).toBe(1500)
    expect(o.route_source).toBe('osrm')
    expect(o.crosses_border).toBe(false)
    expect(o.pricing_breakdown).toEqual([
      { key: 'base', labelKey: 'pricing.base', amountBrl: 10 },
      { key: 'items_subtotal', labelKey: 'pricing.items_subtotal', amountBrl: 74 },
    ])
  })

  test('a origem de um pedido delivery é a loja, do banco, seja o que for que o cliente mandou como coleta', async () => {
    const client = await mkProfile()
    const s = await shop()
    const out = await create({
      client, kind: 'delivery', merchant: s.m, items: basket(s), pickup: { ...A1, street_name: 'Rua que o cliente inventou' },
    })
    const o = await orderRow(out.orderId)
    expect(o.pickup_address).toMatchObject({ merchantId: s.m, city: 'quarai', country: 'BR', lat: -30.3791, lng: -56.4514 })
    expect(JSON.stringify(o.pickup_address)).not.toContain('inventou')
  })

  test('alterar pricing_rules depois NÃO altera o pedido já criado', async () => {
    const client = await mkProfile()
    const out = await create({ client, kind: 'courier' })
    const before = await orderRow(out.orderId)
    expect(before.total_brl).toBe('10.00')

    // a regra em vigor é fechada amanhã e uma nova, bem mais cara, entra amanhã
    await db.query(`update public.pricing_rules set valid_to = ${TODAY} + 1 where city = 'quarai' and kind = 'courier' and valid_to is null`)
    await db.query(
      `insert into public.pricing_rules (city, kind, base_fare_brl, included_km, per_km_brl, min_fare_brl, valid_from)
       values ('quarai', 'courier', 99, 2, 9, 99, ${TODAY} + 1)`,
    )
    const tomorrow = await db.query<{ q: { totalBrl: number } }>(
      `select public.quote_order('courier', $1::jsonb, $2::jsonb, null, null, now() + interval '1 day', 1500, 'osrm') as q`,
      [JSON.stringify(Q1), JSON.stringify(Q2)],
    )
    expect(tomorrow.rows[0].q.totalBrl).toBe(99) // a mudança é real...

    const after = await orderRow(out.orderId)
    expect(after.total_brl).toBe('10.00') // ...e o pedido não se mexeu
    expect(after.pricing_breakdown).toEqual(before.pricing_breakdown)
    expect(after.pricing_rule_id).toBe(before.pricing_rule_id)
  })

  test('order_items guarda name_snapshot, unit_price_brl_snapshot (com opções), qty, opções e total da linha', async () => {
    const client = await mkProfile()
    const s = await shop()
    const out = await create({ client, kind: 'delivery', merchant: s.m, items: basket(s) })
    const rows = (
      await db.query(
        `select item_id, name_snapshot, unit_price_brl_snapshot, qty, options_snapshot, line_total_brl
         from public.order_items where order_id = $1 order by name_snapshot`,
        [out.orderId],
      )
    ).rows
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ item_id: s.burger, name_snapshot: 'Hambúrguer', unit_price_brl_snapshot: '33.00', qty: 2, line_total_brl: '66.00' })
    expect(rows[0].options_snapshot).toEqual([
      { id: s.large, name: 'Grande', priceDeltaBrl: 4.1 },
      { id: s.bacon, name: 'Bacon', priceDeltaBrl: 3 },
    ].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)))
    expect(rows[1]).toMatchObject({ item_id: s.soda, name_snapshot: 'Refrigerante', unit_price_brl_snapshot: '8.00', qty: 1, line_total_brl: '8.00', options_snapshot: [] })
    // as linhas somam exatamente o items_subtotal do preço congelado
    const sum = rows.reduce((t, r) => t + Math.round(Number(r.line_total_brl) * 100), 0)
    expect(sum).toBe(7400)
  })

  test('alterar o preço do item no cardápio depois NÃO altera o pedido existente', async () => {
    const client = await mkProfile()
    const s = await shop()
    const out = await create({ client, kind: 'delivery', merchant: s.m, items: basket(s) })
    await db.query(`update public.catalog_items set price_brl = 99.99, name = 'Outro nome' where id = $1`, [s.burger])
    await db.query(`update public.item_options set price_delta_brl = 50, name = 'Renomeada' where id = $1`, [s.large])
    const row = (await db.query(`select name_snapshot, unit_price_brl_snapshot, line_total_brl, options_snapshot from public.order_items where order_id = $1 and item_id = $2`, [out.orderId, s.burger])).rows[0]
    expect(row.name_snapshot).toBe('Hambúrguer')
    expect(row.unit_price_brl_snapshot).toBe('33.00')
    expect(row.line_total_brl).toBe('66.00')
    expect(JSON.stringify(row.options_snapshot)).toContain('Grande')
    expect((await orderRow(out.orderId)).total_brl).toBe('84.00')
  })

  test('o preço dos itens vem do banco: um preço, total ou delta mandado pelo cliente é ignorado', async () => {
    const client = await mkProfile()
    const s = await shop()
    const items = [{ itemId: s.soda, qty: 1, priceBrl: 0.01, price_brl: 0.01, unitPrice: 0, totalBrl: 0, optionDeltas: [-5] }]
    const out = await create({ client, kind: 'delivery', merchant: s.m, items })
    expect(out.totalBrl).toBe(18) // 10 de entrega + 8 do refrigerante, não 10.01
  })
})

// ===========================================================================================================
describe('o total do cliente contra o do servidor (spec 5.2.5)', () => {
  test('divergência de um centavo é aceita; de dois centavos é rejeitada, nos dois sentidos', async () => {
    const client = await mkProfile()
    const high1 = await create({ client, totalBrl: 10.01 })
    const low1 = await create({ client, totalBrl: 9.99 })
    await create({ client, totalBrl: '10.00' })
    // o aceite tolera o centavo, mas o que se GRAVA é sempre o preço do servidor, nunca o número do cliente
    for (const o of [high1, low1]) {
      expect(await orderRow(o.orderId)).toMatchObject({ total_brl: '10.00', total_charged: '10.00' })
      expect(o.totalBrl).toBe(10)
    }
    const high = await mismatched({ client, totalBrl: 10.02 })
    const low = await mismatched({ client, totalBrl: 9.98 })
    expect(high).toMatchObject({ ok: false, code: 'price_mismatch', totalBrl: 10 })
    expect(low.code).toBe('price_mismatch')
    expect((await counts(client)).orders).toBe(3) // só as três honestas
  })

  test('a divergência é registrada em audit_log: quem, quanto o cliente viu, quanto o servidor cobraria', async () => {
    const client = await mkProfile()
    const before = Number((await db.query(`select count(*)::int as n from public.audit_log where action = 'price_mismatch' and actor_id = $1`, [client])).rows[0].n)
    expect(before).toBe(0)
    await mismatched({ client, totalBrl: 1.0 })
    const rows = (await db.query(`select * from public.audit_log where action = 'price_mismatch' and actor_id = $1`, [client])).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor_role: 'client', table_name: 'orders', record_id: null })
    expect(rows[0].before).toEqual({ clientTotalBrl: 1, clientTotalUyu: null })
    expect(rows[0].after).toMatchObject({ serverTotalBrl: 10, kind: 'courier', distanceM: 1500, routeSource: 'osrm' })
    // o registro de auditoria também não carrega comissão
    expect(JSON.stringify(rows[0])).not.toMatch(/commission|comiss/i)
  })

  test('uma divergência não deixa pedido parcial: nada em orders, order_items, order_events nem order_commissions', async () => {
    const client = await mkProfile()
    const s = await shop()
    await mismatched({ client, kind: 'delivery', merchant: s.m, items: basket(s), totalBrl: 80 })
    expect(await counts(client)).toEqual(NOTHING)
  })

  test('NaN, nulo e total ausente nunca passam por "perto o bastante"', async () => {
    const client = await mkProfile()
    expect((await mismatched({ client, totalBrl: 'NaN' })).code).toBe('price_mismatch')
    expect((await mismatched({ client, totalBrl: 0 })).code).toBe('price_mismatch')
    expect((await mismatched({ client, totalBrl: -10 })).code).toBe('price_mismatch')
    const nul = await refused({ client, totalBrl: null })
    expect(nul.code).toBe('22004')
    expect(await counts(client)).toEqual(NOTHING)
  })

  test('pagando em pesos, o total em pesos que o cliente viu tem de ser exatamente o do servidor', async () => {
    const client = await mkProfile()
    // 10 BRL a 7.00 + 5% = 73.5 -> 74 pesos
    const out = await create({ client, pay: 'dinheiro_uyu', changeFor: 100, totalBrl: 10, totalUyu: 74 })
    expect(out).toMatchObject({ currencyCharged: 'UYU', totalCharged: 74 })
    const wrong = await mismatched({ client, pay: 'dinheiro_uyu', changeFor: 100, totalBrl: 10, totalUyu: 73 })
    expect(wrong).toMatchObject({ code: 'price_mismatch', totalUyu: 74 })
    const missing = await mismatched({ client, pay: 'dinheiro_uyu', changeFor: 100, totalBrl: 10, totalUyu: null })
    expect(missing.code).toBe('price_mismatch')
    expect((await counts(client)).orders).toBe(1)
  })
})

// ===========================================================================================================
describe('disponibilidade e loja', () => {
  test('item indisponível entre montar e confirmar rejeita e diz qual item', async () => {
    const client = await mkProfile()
    const s = await shop()
    await db.query(`update public.catalog_items set is_available = false where id = $1`, [s.soda])
    const r = await refused({ client, kind: 'delivery', merchant: s.m, items: basket(s), totalBrl: 84 })
    expect(r.code).toBe('TD007')
    expect(r.message).toBe('Refrigerante')
    expect(await counts(client)).toEqual(NOTHING)
  })

  test('opção indisponível rejeita e diz qual opção', async () => {
    const client = await mkProfile()
    const s = await shop()
    await db.query(`update public.item_options set is_available = false where id = $1`, [s.bacon])
    const r = await refused({ client, kind: 'delivery', merchant: s.m, items: basket(s), totalBrl: 84 })
    expect(r.code).toBe('TD007')
    expect(r.message).toBe('Bacon')
  })

  test('loja fechada no instante da confirmação rejeita o pedido (interruptor manual)', async () => {
    const client = await mkProfile()
    const s = await shop()
    const first = await create({ client, kind: 'delivery', merchant: s.m, items: basket(s), totalBrl: 84 })
    expect(first.ok).toBe(true)
    await db.query(`update public.merchants set is_open_manual = false where id = $1`, [s.m])
    const r = await refused({ client, kind: 'delivery', merchant: s.m, items: basket(s), totalBrl: 84 })
    expect(r.code).toBe('TD003')
    expect((await counts(client)).orders).toBe(1)
  })

  test('loja sem nenhuma faixa de horário está fechada; loja com a faixa de agora, aberta', async () => {
    const client = await mkProfile()
    const closed = await shop({ hours: false })
    expect((await refused({ client, kind: 'delivery', merchant: closed.m, items: basket(closed), totalBrl: 84 })).code).toBe('TD003')
    // faixa que não contém agora: começa daqui a 1 h e dura 1 h, em todos os dias da semana
    const later = await shop({ hours: false })
    await db.query(
      `insert into public.merchant_hours (merchant_id, weekday, opens_at, closes_at)
       select $1, d, to_char((now() at time zone 'America/Sao_Paulo') + interval '1 hour', 'HH24:MI')::time,
                     to_char((now() at time zone 'America/Sao_Paulo') + interval '2 hours', 'HH24:MI')::time
       from generate_series(0, 6) d`,
      [later.m],
    )
    expect((await refused({ client, kind: 'delivery', merchant: later.m, items: basket(later), totalBrl: 84 })).code).toBe('TD003')
    // faixa que contém agora (começou há 1 h, termina daqui a 1 h)
    const now = await shop({ hours: false })
    await db.query(
      `insert into public.merchant_hours (merchant_id, weekday, opens_at, closes_at)
       select $1, d, to_char((now() at time zone 'America/Sao_Paulo') - interval '1 hour', 'HH24:MI')::time,
                     to_char((now() at time zone 'America/Sao_Paulo') + interval '1 hour', 'HH24:MI')::time
       from generate_series(0, 6) d`,
      [now.m],
    )
    expect((await create({ client, kind: 'delivery', merchant: now.m, items: basket(now), totalBrl: 84 })).ok).toBe(true)
  })

  test('loja pendente ou suspensa não recebe pedido', async () => {
    const client = await mkProfile()
    for (const status of ['pending', 'suspended']) {
      const s = await shop({ status })
      const r = await refused({ client, kind: 'delivery', merchant: s.m, items: basket(s), totalBrl: 84 })
      expect(r.code, status).toBe('TD002')
    }
    const ghost = await refused({ client, kind: 'delivery', merchant: randomUUID(), items: [{ itemId: randomUUID(), qty: 1 }], totalBrl: 84 })
    expect(ghost.code).toBe('TD002')
    expect(await counts(client)).toEqual(NOTHING)
  })

  test('uma loja que não aceita travessia recusa pedido para o outro país; uma que aceita, não', async () => {
    const client = await mkProfile()
    const no = await shop({ cross: false })
    const yes = await shop({ cross: true })
    const r = await refused({ client, kind: 'delivery', merchant: no.m, items: basket(no), dropoff: A1, totalBrl: 94 })
    expect(r.code).toBe('TD004')
    // a loja que não aceita atende normalmente na própria cidade
    expect((await create({ client, kind: 'delivery', merchant: no.m, items: basket(no), dropoff: Q2, totalBrl: 84 })).ok).toBe(true)
    const out = await create({ client, kind: 'delivery', merchant: yes.m, items: basket(yes), dropoff: A1, totalBrl: 92 })
    expect(out.totalBrl).toBe(92) // 10 + 8 de travessia + 74
    const o = await orderRow(out.orderId)
    expect(o.crosses_border).toBe(true)
    expect(JSON.stringify(o.pricing_breakdown)).toContain('cross_border_fee')
  })
})

// ===========================================================================================================
describe('rejeição não deixa pedido parcial', () => {
  test('toda recusa deixa zero linhas em orders, order_items, order_events e order_commissions', async () => {
    const client = await mkProfile()
    const s = await shop()
    const closedShop = await shop({ manual: false })
    const unavailable = await shop()
    await db.query(`update public.catalog_items set is_available = false where id = $1`, [unavailable.soda])
    await db.query(
      `insert into public.zones (city, name, polygon, is_served, notes) values ('quarai', 'bloqueada', $1::jsonb, false, 'Fora da área')`,
      [JSON.stringify(square(Z))],
    )
    const cases: [string, string, Args][] = [
      ['loja fechada', 'TD003', { client, kind: 'delivery', merchant: closedShop.m, items: basket(closedShop), dropoff: Q1, totalBrl: 84 }],
      ['item indisponível', 'TD007', { client, kind: 'delivery', merchant: unavailable.m, items: basket(unavailable), dropoff: Q1, totalBrl: 84 }],
      ['zona não atendida', 'TD006', { client, kind: 'delivery', merchant: s.m, items: basket(s), dropoff: Z, totalBrl: 84 }],
      ['distância absurda', 'TD009', { client, distance: 500_000, totalBrl: 10 }],
      ['troco insuficiente', 'TD008', { client, pay: 'dinheiro_brl', changeFor: 5, totalBrl: 10 }],
      ['pix com troco', 'TD008', { client, pay: 'pix', changeFor: 50, totalBrl: 10 }],
      ['sem coordenadas', '22023', { client, dropoff: { city: 'quarai', country: 'BR' }, totalBrl: 10 }],
      ['item de outra loja', '22023', { client, kind: 'delivery', merchant: s.m, items: [{ itemId: randomUUID(), qty: 1 }], dropoff: Q1, totalBrl: 84 }],
    ]
    for (const [name, code, a] of cases) {
      const r = await refused(a)
      expect(r.code, name).toBe(code) // recusada pelo motivo certo, não por acidente
      expect(await counts(client), name).toEqual(NOTHING)
    }
    await mismatched({ client, totalBrl: 3 })
    expect(await counts(client)).toEqual(NOTHING)
  })

  test('uma falha no meio da gravação (depois do pedido e dos itens) desfaz tudo', async () => {
    const client = await mkProfile()
    const s = await shop()
    await db.query(
      `create function pg_temp.boom() returns trigger language plpgsql as $$ begin raise exception 'falha injetada' using errcode = 'XX999'; end $$`,
    )
    // order_commissions é escrita DEPOIS de orders e order_items: quando falha, os dois já foram gravados
    await db.query(`create trigger boom before insert on public.order_commissions for each row execute function pg_temp.boom()`)
    const r = await refused({ client, kind: 'delivery', merchant: s.m, items: basket(s), totalBrl: 84 })
    expect(r.code).toBe('XX999')
    expect(await counts(client)).toEqual(NOTHING)
  })
})

// ===========================================================================================================
describe('courier e ride', () => {
  test('kind courier e ride aceitam merchant_id nulo', async () => {
    const client = await mkProfile()
    const a = await create({ client, kind: 'courier', pickup: Q1, dropoff: Q2 })
    const b = await create({ client, kind: 'ride', pickup: Q1, dropoff: Q2 })
    for (const [out, kind] of [[a, 'courier'], [b, 'ride']] as const) {
      const o = await orderRow(out.orderId)
      expect(o.kind).toBe(kind)
      expect(o.merchant_id).toBeNull()
      expect(o.pickup_address).toMatchObject({ city: 'quarai', lat: Q1.lat, lng: Q1.lng })
      expect(o.dropoff_address).toMatchObject({ city: 'quarai', lat: Q2.lat, lng: Q2.lng })
    }
  })

  test('ride atravessando cobra a taxa de passageiro e marca crosses_border', async () => {
    const client = await mkProfile()
    const out = await create({ client, kind: 'ride', pickup: Q1, dropoff: A1, totalBrl: 22 })
    const o = await orderRow(out.orderId)
    expect(o.crosses_border).toBe(true)
    expect(o.total_brl).toBe('22.00')
    expect(JSON.stringify(o.pricing_breakdown)).toContain('passenger_cross_border_fee')
  })

  test('endereço sem coordenadas não pode ser cotado: pickup ou dropoff, courier ou ride', async () => {
    const client = await mkProfile()
    const semLat = { city: 'quarai', country: 'BR', lng: -56.45 }
    const semLng = { city: 'quarai', country: 'BR', lat: -30.38 }
    expect((await refused({ client, dropoff: semLat, totalBrl: 10 })).code).toBe('22023')
    expect((await refused({ client, dropoff: semLng, totalBrl: 10 })).code).toBe('22023')
    expect((await refused({ client, kind: 'ride', pickup: semLat, totalBrl: 10 })).code).toBe('22023')
    expect((await refused({ client, pickup: null, totalBrl: 10 })).code).toBe('22023')
    expect(await counts(client)).toEqual(NOTHING)
  })

  test('endereço sem street_id (rua que não está no mapa) é aceito e carrega o nome digitado nas duas pontas', async () => {
    const client = await mkProfile()
    const livre = { ...Q1, street_id: null, street_name: 'Rua que o mapa não tem', reference: 'casa verde', precision: 'gps' }
    const out = await create({ client, kind: 'courier', pickup: livre, dropoff: { ...Q2, street_id: null, street_name: 'Outra rua fora do mapa' } })
    const o = await orderRow(out.orderId)
    expect(o.pickup_address).toMatchObject({ street_id: null, street_name: 'Rua que o mapa não tem', lat: Q1.lat })
    expect(o.dropoff_address).toMatchObject({ street_name: 'Outra rua fora do mapa', lng: Q2.lng })
  })

  test('uma loja mandada num pedido courier é recusada', async () => {
    const client = await mkProfile()
    const s = await shop()
    expect((await refused({ client, kind: 'courier', merchant: s.m, totalBrl: 10 })).code).toBe('22023')
  })
})

// ===========================================================================================================
describe('zonas e horário de serviço', () => {
  test('pedido em zona não servida é rejeitado com a mensagem da zona', async () => {
    const client = await mkProfile()
    await db.query(
      `insert into public.zones (city, name, polygon, is_served, notes) values ('quarai', 'Barro Vermelho', $1::jsonb, false, 'Barro Vermelho ainda não tem entrega.')`,
      [JSON.stringify(square(Q2))],
    )
    const r = await refused({ client, dropoff: Q2, totalBrl: 10 })
    expect(r.code).toBe('TD006')
    expect(r.message).toBe('Barro Vermelho ainda não tem entrega.')
    expect(await counts(client)).toEqual(NOTHING)
  })

  test('zona sem mensagem própria usa a mensagem padrão das settings', async () => {
    const client = await mkProfile()
    await db.query(`insert into public.zones (city, name, polygon, is_served) values ('quarai', 'x', $1::jsonb, false)`, [JSON.stringify(square(Q2))])
    const expected = (await db.query<{ m: string }>(`select value ->> 'pt-BR' as m from public.settings where key = 'unserved_zone_message'`)).rows[0].m
    const r = await refused({ client, dropoff: Q2, totalBrl: 10 })
    expect(r.code).toBe('TD006')
    expect(r.message).toBe(expected)
  })

  test('fora do horário de serviço o pedido é recusado, mesmo um pedido de mesma cidade', async () => {
    const client = await mkProfile()
    await closeServiceNow('quarai')
    const r = await refused({ client, totalBrl: 10 })
    expect(r.code).toBe('TD005')
    expect(await counts(client)).toEqual(NOTHING)
  })

  test('uma travessia exige as DUAS cidades abertas; a ponte em si nunca fecha', async () => {
    const client = await mkProfile()
    await closeServiceNow('artigas')
    // Quaraí aberta, Artigas fechada: o pedido de Quaraí para Quaraí passa...
    expect((await create({ client, pickup: Q1, dropoff: Q2, totalBrl: 10 })).ok).toBe(true)
    // ...mas atravessar para Artigas (ou vir de lá) não
    expect((await refused({ client, pickup: Q1, dropoff: A1, totalBrl: 18 })).code).toBe('TD005')
    expect((await refused({ client, pickup: A1, dropoff: Q1, totalBrl: 18 })).code).toBe('TD005')
  })

  test('com as duas cidades abertas, atravessar nunca é recusado por hora do dia (a ponte tem 24 h)', async () => {
    const client = await mkProfile()
    const out = await create({ client, pickup: Q1, dropoff: A1, totalBrl: 18 })
    expect((await orderRow(out.orderId)).crosses_border).toBe(true)
  })
})

// ===========================================================================================================
describe('pagamento', () => {
  test('dinheiro_uyu exige change_for, e maior ou igual ao total cobrado em pesos', async () => {
    const client = await mkProfile()
    // 10 BRL = 74 pesos
    const none = await refused({ client, pay: 'dinheiro_uyu', changeFor: null, totalBrl: 10, totalUyu: 74 })
    expect(none.code).toBe('TD008')
    const short = await refused({ client, pay: 'dinheiro_uyu', changeFor: 73, totalBrl: 10, totalUyu: 74 })
    expect(short.code).toBe('TD008')
    // as 10 unidades de "reais" seriam suficientes se a comparação fosse feita na moeda errada
    const reais = await refused({ client, pay: 'dinheiro_uyu', changeFor: 10, totalBrl: 10, totalUyu: 74 })
    expect(reais.code).toBe('TD008')
    expect(await counts(client)).toEqual(NOTHING)

    const exact = await create({ client, pay: 'dinheiro_uyu', changeFor: 74, totalBrl: 10, totalUyu: 74 })
    const more = await create({ client, pay: 'dinheiro_uyu', changeFor: 100, totalBrl: 10, totalUyu: 74 })
    for (const [out, change] of [[exact, '74.00'], [more, '100.00']] as const) {
      const o = await orderRow(out.orderId)
      expect(o).toMatchObject({ payment_method: 'dinheiro_uyu', currency_charged: 'UYU', total_charged: '74.00', total_brl: '10.00', change_for: change })
    }
  })

  test('dinheiro_brl: troco opcional, mas se vier tem de cobrir o total em reais', async () => {
    const client = await mkProfile()
    expect((await refused({ client, pay: 'dinheiro_brl', changeFor: 9.99, totalBrl: 10 })).code).toBe('TD008')
    const exact = await create({ client, pay: 'dinheiro_brl', changeFor: 10, totalBrl: 10 })
    const none = await create({ client, pay: 'dinheiro_brl', totalBrl: 10 })
    expect(await orderRow(exact.orderId)).toMatchObject({ change_for: '10.00', currency_charged: 'BRL', total_charged: '10.00' })
    expect(await orderRow(none.orderId)).toMatchObject({ change_for: null, currency_charged: 'BRL' })
  })

  test('pix não tem troco, e NaN nunca é um troco', async () => {
    const client = await mkProfile()
    expect((await refused({ client, pay: 'pix', changeFor: 20, totalBrl: 10 })).code).toBe('TD008')
    expect((await refused({ client, pay: 'dinheiro_brl', changeFor: 'NaN', totalBrl: 10 })).code).toBe('TD008')
    expect((await create({ client, pay: 'pix', totalBrl: 10 })).ok).toBe(true)
  })
})

// ===========================================================================================================
describe('a comissão', () => {
  test('order_commissions recebe exatamente uma linha, com a comissão do quote, fora do breakdown', async () => {
    const client = await mkProfile()
    const s = await shop({ commission: 12.5 })
    const quote = await serverQuote({ client, kind: 'delivery', merchant: s.m, items: basket(s) })
    expect(quote.commissionBrl).toBe(9.25) // 12,5% de 74.00
    const out = await create({ client, kind: 'delivery', merchant: s.m, items: basket(s) })
    const rows = (await db.query(`select commission_brl from public.order_commissions where order_id = $1`, [out.orderId])).rows
    expect(rows).toEqual([{ commission_brl: '9.25' }])
    const o = await orderRow(out.orderId)
    expect(JSON.stringify(o.pricing_breakdown)).not.toMatch(/commission|comiss/i)
    // nem a resposta ao navegador carrega a comissão
    expect(JSON.stringify(out)).not.toMatch(/commission|comiss/i)
  })

  test('courier e ride também têm sua linha (zero): a relação com orders é um para um', async () => {
    const client = await mkProfile()
    const out = await create({ client, kind: 'courier' })
    const rows = (await db.query(`select commission_brl from public.order_commissions where order_id = $1`, [out.orderId])).rows
    expect(rows).toEqual([{ commission_brl: '0.00' }])
  })

  test('o cliente lê o próprio pedido e o breakdown, e nunca a comissão (RLS de verdade)', async () => {
    const client = await mkProfile()
    const s = await shop({ commission: 12.5 })
    const out = await create({ client, kind: 'delivery', merchant: s.m, items: basket(s) })
    await actAs(db, { uid: client })
    const orders = (await db.query(`select id, pricing_breakdown from public.orders`)).rows
    expect(orders.map((r) => r.id)).toEqual([out.orderId])
    expect((await db.query(`select * from public.order_commissions`)).rows).toEqual([])
    await actAs(db, 'postgres')
    expect((await db.query(`select count(*)::int as n from public.order_commissions where order_id = $1`, [out.orderId])).rows[0].n).toBe(1)
  })
})

// ===========================================================================================================
describe('o primeiro evento e o código', () => {
  test('o primeiro order_events registra criado com actor_role client, e é o único', async () => {
    const client = await mkProfile()
    const out = await create({ client })
    const rows = (await db.query(`select from_status, to_status, actor_id, actor_role from public.order_events where order_id = $1`, [out.orderId])).rows
    expect(rows).toEqual([{ from_status: null, to_status: 'criado', actor_id: client, actor_role: 'client' }])
  })

  test('o código tem 6 caracteres legíveis ao telefone (sem 0, O, 1, I) e é único', async () => {
    const client = await mkProfile()
    await db.query(`insert into public.settings (key, value) values ('orders.rate_limit_per_10min', '20') on conflict (key) do update set value = '20'`)
    const codes: string[] = []
    for (let i = 0; i < 12; i++) codes.push((await create({ client })).code)
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
    expect(new Set(codes).size).toBe(codes.length)
  })

  test('uma colisão de código é refeita com outro código, não vira erro para o cliente', async () => {
    const client = await mkProfile()
    const other = await mkProfile()
    // random() com semente: o primeiro código que a função vai sortear é conhecido, e já está ocupado
    await db.query(`select setseed(0.42)`)
    const taken = (await db.query<{ c: string }>(`select public.gen_order_code() as c`)).rows[0].c
    await db.query(`select setseed(0.42)`)
    await db.query(
      `insert into public.orders (code, kind, client_id, pickup_address, dropoff_address, total_brl, total_charged, payment_method)
       values ($1, 'courier', $2, '{}', '{}', 10, 10, 'pix')`,
      [taken, other],
    )
    const out = await create({ client, totalBrl: 10 }) // a semente é reposta antes: params() consulta o quote, que não usa random()
    expect(out.code).not.toBe(taken)
    expect(out.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
  })
})

// ===========================================================================================================
describe('rate limit por profile (spec 5.2.6)', () => {
  test('mais de 5 pedidos do mesmo cliente em 10 minutos é recusado; o sexto cai, os cinco ficam', async () => {
    const client = await mkProfile()
    for (let i = 0; i < 5; i++) await create({ client })
    const sixth = await refused({ client })
    expect(sixth.code).toBe('TD001')
    expect((await counts(client)).orders).toBe(5)
  })

  test('conta por profile_id, não por IP: outro cliente, mesma conexão, mesmo IP, não é afetado', async () => {
    const a = await mkProfile()
    const b = await mkProfile()
    for (let i = 0; i < 5; i++) await create({ client: a })
    expect((await refused({ client: a })).code).toBe('TD001')
    // b vem da MESMA conexão (o mesmo IP, em produção): o limite de a não é dele
    for (let i = 0; i < 5; i++) await create({ client: b })
    expect((await refused({ client: b })).code).toBe('TD001')
    expect((await counts(a)).orders).toBe(5)
    expect((await counts(b)).orders).toBe(5)
  })

  test('o limite vem de settings["orders.rate_limit_per_10min"]', async () => {
    const client = await mkProfile()
    await db.query(`update public.settings set value = '2' where key = 'orders.rate_limit_per_10min'`)
    await create({ client })
    await create({ client })
    expect((await refused({ client })).code).toBe('TD001')
    await db.query(`update public.settings set value = '"3"' where key = 'orders.rate_limit_per_10min'`) // texto numérico também vale
    await create({ client })
    expect((await refused({ client })).code).toBe('TD001')
  })

  test('um valor inválido nas settings não desliga o limite: cai no padrão 5', async () => {
    for (const bad of ['0', '-1', '"muitos"', 'null', '1.5', '{"a":1}']) {
      const client = await mkProfile() // um cliente novo por valor: pedido nunca se apaga, nem em teste
      await db.query(`update public.settings set value = $1::jsonb where key = 'orders.rate_limit_per_10min'`, [bad])
      for (let i = 0; i < 5; i++) await create({ client })
      expect((await refused({ client })).code, bad).toBe('TD001')
    }
  })

  test('a janela é de 10 minutos: pedido de 9min59s conta, pedido de exatamente 10 min não', async () => {
    const client = await mkProfile()
    const client2 = await mkProfile() // pedido nunca se apaga, nem em teste: o segundo cenário usa outro cliente
    await db.query(`update public.settings set value = '1' where key = 'orders.rate_limit_per_10min'`)
    const old = (at: string, who = client) =>
      db.query(
        `insert into public.orders (kind, client_id, pickup_address, dropoff_address, total_brl, total_charged, payment_method, created_at)
         values ('courier', $1, '{}', '{}', 10, 10, 'pix', now() - $2::interval)`,
        [who, at],
      )
    await old('9 minutes 59 seconds')
    expect((await refused({ client })).code).toBe('TD001')
    await old('10 minutes', client2)
    await old('3 hours', client2)
    expect((await create({ client: client2 })).ok).toBe(true) // os dois antigos já não contam
  })

  test('check-then-insert é atômico por cliente: a função segura o lock do cliente até o fim da transação', async () => {
    const client = await mkProfile()
    await create({ client })
    const other = await connect()
    try {
      await other.query('begin')
      const held = await other.query<{ got: boolean }>(`select pg_try_advisory_xact_lock(hashtextextended('create_order:' || $1::text, 0)) as got`, [client])
      expect(held.rows[0].got, 'outra sessão não pode pegar o lock do cliente enquanto o pedido dele está aberto').toBe(false)
      // e o de OUTRO cliente está livre: o lock é por profile
      const free = await other.query<{ got: boolean }>(`select pg_try_advisory_xact_lock(hashtextextended('create_order:' || $1::text, 0)) as got`, [randomUUID()])
      expect(free.rows[0].got).toBe(true)
    } finally {
      await other.query('rollback')
      await other.end()
    }
  })
})

// ===========================================================================================================
describe('teto de sanidade da distância', () => {
  test('acima do teto (20 km por padrão) é recusado; no teto passa', async () => {
    const client = await mkProfile()
    const r = await refused({ client, distance: 20_001, totalBrl: 10 })
    expect(r.code).toBe('TD009')
    expect(await counts(client)).toEqual(NOTHING)
    // 20 km, no teto: 10 + 18 km × 2.50 = 55.00
    expect((await create({ client, distance: 20_000, totalBrl: 55 })).totalBrl).toBe(55)
  })

  test('o teto vem de settings["orders.max_distance_m"]; valor inválido cai no padrão', async () => {
    const client = await mkProfile()
    await db.query(`update public.settings set value = '6000' where key = 'orders.max_distance_m'`)
    expect((await refused({ client, distance: 6001, totalBrl: 10 })).code).toBe('TD009')
    expect((await create({ client, distance: 6000 })).ok).toBe(true)
    for (const bad of ['"abc"', '0', '-5', 'null', '1.5']) {
      await db.query(`update public.settings set value = $1::jsonb where key = 'orders.max_distance_m'`, [bad])
      expect((await refused({ client, distance: 20_001, totalBrl: 10 })).code, bad).toBe('TD009') // cai no padrão de 20 km
      expect((await create({ client: await mkProfile(), distance: 20_000, totalBrl: 55 })).ok, bad).toBe(true) // e não trava tudo
    }
  })

  test('distância negativa é recusada', async () => {
    const client = await mkProfile()
    expect((await refused({ client, distance: -1, totalBrl: 10 })).code).toBe('22023')
  })
})

// ===========================================================================================================
describe('quem pode chamar', () => {
  test('só o servidor: authenticated e anon não executam create_order', async () => {
    const client = await mkProfile()
    const args = await params({ client, totalBrl: 10 })
    for (const who of [{ uid: client }, 'anon'] as const) {
      await actAs(db, who)
      const r = await attempt(db, CALL, args)
      expect(r.ok, String(who)).toBe(false)
      expect((r as { code?: string }).code).toBe('42501')
    }
    await actAs(db, 'postgres')
    expect(await counts(client)).toEqual(NOTHING)
  })

  test.skipIf(!!MUTANT_SQL)('o service_role (a Server Action) executa', async () => {
    const client = await mkProfile()
    const args = await params({ client, totalBrl: 10 })
    await db.query('set local role service_role')
    const r = await attempt(db, CALL, args)
    await db.query('reset role')
    expect(r.ok).toBe(true)
  })

  test('só um cliente ativo pede: courier, admin, bloqueado, pendente e perfil inexistente são recusados', async () => {
    for (const [role, status] of [['courier', 'active'], ['admin', 'active'], ['merchant', 'active'], ['client', 'blocked'], ['client', 'pending']]) {
      const who = await mkProfile(role, status)
      expect((await refused({ client: who, totalBrl: 10 })).code, `${role}/${status}`).toBe('TD010')
      expect(await counts(who)).toEqual(NOTHING)
    }
    expect((await refused({ client: randomUUID(), totalBrl: 10 })).code).toBe('TD010')
  })

  test('endereços e notas têm tamanho máximo', async () => {
    const client = await mkProfile()
    const huge = { ...Q2, reference: 'x'.repeat(5000) }
    expect((await refused({ client, dropoff: huge, totalBrl: 10 })).code).toBe('22023')
    expect((await refused({ client, notes: 'n'.repeat(501), totalBrl: 10 })).code).toBe('22023')
    expect((await create({ client, notes: '  sem cebola  ', totalBrl: 10 })).ok).toBe(true)
    expect(await counts(client)).toMatchObject({ orders: 1 })
    const notes = (await db.query(`select client_notes from public.orders where client_id = $1`, [client])).rows[0].client_notes
    expect(notes).toBe('sem cebola')
  })
})

// ===========================================================================================================
describe('private.merchant_is_open: a regra da spec com instantes fixos', () => {
  // 2099-06-10 12:00 local (UTC-3). O dia da semana é calculado pelo banco, não por mim.
  const at = (z: string) => z
  const DOW = `extract(dow from ('2099-06-10T15:00:00Z'::timestamptz at time zone 'America/Sao_Paulo'))::int`
  const open = async (m: string, z: string) =>
    (await db.query<{ o: boolean }>(`select private.merchant_is_open($1, $2::timestamptz) as o`, [m, at(z)])).rows[0].o
  const band = (m: string, weekdaySql: string, from: string, to: string) =>
    db.query(`insert into public.merchant_hours (merchant_id, weekday, opens_at, closes_at) values ($1, ${weekdaySql}, $2, $3)`, [m, from, to])

  test('faixa comum [09:00, 18:00): o começo conta, o fim não; outro dia da semana não conta', async () => {
    const m = await merchant({ hours: false })
    await band(m, DOW, '09:00', '18:00')
    expect(await open(m, '2099-06-10T11:59:59Z')).toBe(false) // 08:59:59
    expect(await open(m, '2099-06-10T12:00:00Z')).toBe(true) // 09:00:00
    expect(await open(m, '2099-06-10T20:59:59Z')).toBe(true) // 17:59:59
    expect(await open(m, '2099-06-10T21:00:00Z')).toBe(false) // 18:00:00
    expect(await open(m, '2099-06-11T15:00:00Z')).toBe(false) // o dia seguinte, sem faixa
  })

  test('faixa que atravessa a meia-noite (18:00-02:00) vale nas duas madrugadas certas', async () => {
    const m = await merchant({ hours: false })
    await band(m, DOW, '18:00', '02:00')
    expect(await open(m, '2099-06-10T20:59:59Z')).toBe(false) // 17:59:59 do mesmo dia
    expect(await open(m, '2099-06-10T21:00:00Z')).toBe(true) // 18:00
    expect(await open(m, '2099-06-11T02:00:00Z')).toBe(true) // 23:00
    expect(await open(m, '2099-06-11T04:59:59Z')).toBe(true) // 01:59:59 do dia seguinte: vem da faixa de ONTEM
    expect(await open(m, '2099-06-11T05:00:00Z')).toBe(false) // 02:00 do dia seguinte
    expect(await open(m, '2099-06-12T04:00:00Z')).toBe(false) // dois dias depois: ninguém abriu
  })

  test('opens = closes é 24 h; sem faixa, fechada; interruptor manual e status ganham da faixa', async () => {
    const all = await merchant({ hours: false })
    await band(all, DOW, '00:00', '00:00')
    expect(await open(all, '2099-06-10T03:00:00Z')).toBe(true)
    expect(await open(all, '2099-06-10T15:00:00Z')).toBe(true)
    const none = await merchant({ hours: false })
    expect(await open(none, '2099-06-10T15:00:00Z')).toBe(false)
    const off = await merchant({ manual: false })
    expect(await open(off, '2099-06-10T15:00:00Z')).toBe(false)
    const pending = await merchant({ status: 'pending' })
    expect(await open(pending, '2099-06-10T15:00:00Z')).toBe(false)
    expect(await open(randomUUID(), '2099-06-10T15:00:00Z')).toBe(false)
  })

  test('várias faixas no dia (almoço e noite): fecha no intervalo', async () => {
    const m = await merchant({ hours: false })
    await band(m, DOW, '11:00', '14:00')
    await band(m, DOW, '18:00', '23:00')
    expect(await open(m, '2099-06-10T15:00:00Z')).toBe(true) // 12:00
    expect(await open(m, '2099-06-10T18:00:00Z')).toBe(false) // 15:00
    expect(await open(m, '2099-06-10T22:00:00Z')).toBe(true) // 19:00
  })
})
