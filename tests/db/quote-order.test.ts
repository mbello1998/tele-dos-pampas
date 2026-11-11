import type { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { connect } from '../../scripts/db/client'
import { getEffectiveRate } from '../../src/lib/fx/rate'
import { convertBrlToUyu } from '../../src/lib/money/format'
import type { Quote, ServerQuote } from '../../src/lib/pricing/types'
import { attempt } from './rls-helpers'
import { installMutant, isMutantRun } from './quote-order-mutants'

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 })

/**
 * quote_order: o motor de preço. Preço e permissão moram no Postgres; o cliente manda intenção.
 *
 * Fixtures. O banco é compartilhado e o histórico é protegido: pricing_rules e fx_rates rejeitam UPDATE e
 * DELETE para qualquer papel (exceto fechar uma versão de pricing_rules com valid_to). Por isso:
 *   - cada teste roda numa transação que sempre sofre rollback;
 *   - nunca editamos uma regra: FECHAMOS a versão semeada com valid_to e INSERIMOS uma nova (newRule);
 *   - datas em 2098/2099, que não colidem com nenhuma linha real; a regra semeada (válida desde 2026-01-01,
 *     sem fim) vale nelas, então os testes que não falam de versão usam o preço padrão de verdade;
 *   - câmbio, zonas, lojas e cardápio são inseridos na transação, nunca lidos do que existir no banco.
 */

let db: Client
let FN = 'public.quote_order'

beforeAll(async () => {
  db = await connect()
})
afterAll(async () => {
  await db.end()
})
beforeEach(async () => {
  await db.query('begin')
  // Em execução de mutante (ver quote-order-mutants.ts) a função testada é uma cópia em pg_temp, dentro desta
  // transação, e a função viva nunca é tocada.
  if (isMutantRun()) FN = await installMutant(db)
})
afterEach(async () => {
  await db.query('rollback')
})

// --- instantes: as duas cidades ficam em UTC-3 o ano inteiro ---------------------------------------------
const NOON = '2099-06-10T15:00:00Z' // 12:00 em Quaraí e Artigas
const NIGHT = '2099-06-11T02:30:00Z' // 23:30 de 10/06 no relógio das cidades (já 11/06 em UTC)
const CLOSED = '2099-06-11T03:30:00Z' // 00:30 de 11/06: serviço fechado (06:00 a 00:00)

// --- pontos ----------------------------------------------------------------------------------------------
type Pt = { city: string; country: string; lat: number; lng: number }
const Q1: Pt = { city: 'quarai', country: 'BR', lat: -30.3791, lng: -56.4514 }
const Q2: Pt = { city: 'quarai', country: 'BR', lat: -30.3850, lng: -56.4480 }
const A1: Pt = { city: 'artigas', country: 'UY', lat: -30.4119, lng: -56.469 }
const A2: Pt = { city: 'artigas', country: 'UY', lat: -30.4000, lng: -56.4750 }

type Extra = Omit<ServerQuote, keyof Quote>
type FullQuote = ServerQuote

type Args = {
  kind?: 'delivery' | 'courier' | 'ride'
  pickup?: Record<string, unknown>
  dropoff?: Record<string, unknown>
  merchant?: string | null
  items?: unknown
  at?: string
  distance?: number | null
  source?: 'osrm' | 'haversine'
}

const SQL_CALL = (fn: string) =>
  `select ${fn}($1::public.order_kind, $2::jsonb, $3::jsonb, $4::uuid, $5::jsonb, $6::timestamptz, $7::integer, $8::public.route_source) as q`

const params = (a: Args) => [
  a.kind ?? 'courier',
  JSON.stringify(a.pickup ?? Q1),
  JSON.stringify(a.dropoff ?? Q2),
  a.merchant ?? null,
  a.items === undefined || a.items === null ? null : JSON.stringify(a.items),
  a.at ?? NOON,
  a.distance === undefined ? 1500 : a.distance,
  a.source ?? 'osrm',
]

async function quote(a: Args = {}): Promise<FullQuote> {
  const r = await db.query<{ q: FullQuote }>(SQL_CALL(FN), params(a))
  return r.rows[0].q
}

/** A chamada que deve ser recusada: devolve o SQLSTATE e a mensagem. */
async function refused(a: Args) {
  const r = await attempt(db, SQL_CALL(FN), params(a))
  expect(r.ok, 'a chamada deveria ter levantado exceção').toBe(false)
  return r as { ok: false; code?: string; message: string }
}

const cents = (x: number) => Math.round(x * 100)
const sumCents = (q: Quote) => q.breakdown.reduce((s, l) => s + cents(l.amountBrl), 0)
const line = (q: Quote, key: string) => q.breakdown.find((l) => l.key === key)

// --- fixtures de banco -----------------------------------------------------------------------------------
type RuleOverrides = Partial<{
  base: number; includedKm: number; perKm: number; minFare: number; night: number
  nightFrom: string; nightTo: string; crossBorder: number; passengerCrossBorder: number
}>

/** Fecha a versão em vigor da (cidade, kind) em `from` e insere a nova a partir dessa data. Nunca edita preço. */
async function newRule(city: string, kind: string, o: RuleOverrides = {}, from = '2099-01-01'): Promise<string> {
  // delivery é cotado na tarifa de convênio (merchant); todo o resto, na de balcão (client). Cada uma tem a sua vigência.
  const audience = kind === 'delivery' ? 'merchant' : 'client'
  await db.query(
    `update public.pricing_rules set valid_to = $3::date where city = $1 and kind = $2::public.order_kind and audience = $4 and valid_to is null`,
    [city, kind, from, audience],
  )
  const r = await db.query<{ id: string }>(
    `insert into public.pricing_rules (city, kind, audience, base_fare_brl, included_km, per_km_brl, min_fare_brl,
       night_surcharge_brl, night_from, night_to, cross_border_fee_brl, passenger_cross_border_fee_brl, valid_from)
     values ($1, $2::public.order_kind, $13, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date) returning id`,
    [
      city, kind, o.base ?? 10, o.includedKm ?? 2, o.perKm ?? 2.5, o.minFare ?? 10, o.night ?? 3,
      o.nightFrom ?? '23:00', o.nightTo ?? '05:00', o.crossBorder ?? 8, o.passengerCrossBorder ?? 12, from, audience,
    ],
  )
  return r.rows[0].id
}

const insertFx = async (rate: string, date: string, o: { spread?: string; manual?: boolean } = {}): Promise<string> => {
  const r = await db.query<{ id: string }>(
    `insert into public.fx_rates (rate, source, spread_pct, is_manual_override, valid_for_date)
     values ($1, $2, $3, $4, $5::date) returning id`,
    [rate, o.manual ? 'manual' : 'fxfeed', o.spread ?? '5', o.manual ?? false, date],
  )
  return r.rows[0].id
}

const square = (c: { lat: number; lng: number }, half = 0.002) => ({
  type: 'Polygon',
  coordinates: [[
    [c.lng - half, c.lat - half], [c.lng + half, c.lat - half], [c.lng + half, c.lat + half],
    [c.lng - half, c.lat + half], [c.lng - half, c.lat - half],
  ]],
})

async function zone(o: { city: string; polygon: unknown; surcharge?: number; served?: boolean; notes?: string | null; name?: string }) {
  const r = await db.query<{ id: string }>(
    `insert into public.zones (city, name, polygon, surcharge_brl, is_served, notes)
     values ($1, $2, $3::jsonb, $4, $5, $6) returning id`,
    [o.city, o.name ?? 'zona de teste', JSON.stringify(o.polygon), o.surcharge ?? 0, o.served ?? true, o.notes ?? null],
  )
  return r.rows[0].id
}

async function merchant(o: { city?: string; country?: string; commission?: number; lat?: number; lng?: number } = {}) {
  const r = await db.query<{ id: string }>(
    `insert into public.merchants (name, kind, city, country, lat, lng, commission_pct, status)
     values ('Loja de teste', 'loja', $1, $2, $3, $4, $5, 'approved') returning id`,
    [o.city ?? 'quarai', o.country ?? 'BR', o.lat ?? Q1.lat, o.lng ?? Q1.lng, o.commission ?? 0],
  )
  return r.rows[0].id
}
/** Uma loja de Quaraí (entrega não tem itens: o preço é só a taxa). */
async function shop() {
  return { m: await merchant() }
}

// ===========================================================================================================
describe('taxa de entrega (spec 7, passo 3)', () => {
  test('1,5 km, dentro do incluso, cobra exatamente a base 10.00', async () => {
    const q = await quote({ distance: 1500 })
    expect(q.blocked).toBe(false)
    expect(q.totalBrl).toBe(10)
    expect(q.breakdown).toEqual([{ key: 'base', labelKey: 'pricing.base', amountBrl: 10 }])
  })

  test('4 km cobra 10.00 + 2 × 2.50 = 15.00, com o excedente em linha própria', async () => {
    const q = await quote({ distance: 4000 })
    expect(q.totalBrl).toBe(15)
    expect(line(q, 'base')?.amountBrl).toBe(10)
    expect(line(q, 'extra_km')?.amountBrl).toBe(5)
  })

  test('exatamente 2 km (o incluso) cobra só a base; o excedente é contínuo, não por km cheio', async () => {
    expect((await quote({ distance: 2000 })).totalBrl).toBe(10)
    expect((await quote({ distance: 2000 })).breakdown).toHaveLength(1) // linha de excedente zero não aparece
    expect((await quote({ distance: 4500 })).totalBrl).toBe(16.25) // 2,5 km × 2.50
    expect((await quote({ distance: 3333 })).totalBrl).toBe(13.33) // 1,333 × 2.50 = 3.3325 -> 3.33
    expect((await quote({ distance: 2010 })).totalBrl).toBe(10.03) // 0,010 × 2.50 = 0.025 -> 0.03 (meio para cima)
    expect((await quote({ distance: 2001 })).totalBrl).toBe(10) // 0.0025 -> 0.00
  })

  test('origem igual ao destino (distância 0) cobra o mínimo, não zero', async () => {
    const q = await quote({ pickup: Q1, dropoff: Q1, distance: 0 })
    expect(q.blocked).toBe(false)
    expect(q.totalBrl).toBe(10)
    expect(q.totalBrl).toBeGreaterThan(0)
    expect(q.distanceM).toBe(0)
  })

  test('nunca fica abaixo do mínimo: com base 5, mínimo 10 e 1/km, o piso cobra 10 numa linha base rotulada de mínimo', async () => {
    await newRule('quarai', 'courier', { base: 5, perKm: 1, minFare: 10 })
    for (const d of [0, 1500, 4000]) {
      const q = await quote({ distance: d }) // 5 + 0 | 5 + 0 | 5 + 2 = 7
      expect(q.totalBrl, `${d} m`).toBe(10)
      expect(q.breakdown).toEqual([{ key: 'base', labelKey: 'pricing.min_fare', amountBrl: 10 }])
    }
    const above = await quote({ distance: 8000 }) // 5 + 6 = 11, acima do mínimo: o piso não interfere
    expect(above.totalBrl).toBe(11)
    expect(above.breakdown.map((l) => l.key)).toEqual(['base', 'extra_km'])
  })

  test('o piso vale só para a taxa de entrega: as sobretaxas entram por cima do mínimo', async () => {
    await newRule('quarai', 'courier', { base: 5, perKm: 1, minFare: 10 })
    await zone({ city: 'quarai', polygon: square(Q2), surcharge: 4 })
    const q = await quote({ distance: 1500, at: NIGHT }) // piso 10 + zona 4 + noite 3
    expect(q.totalBrl).toBe(17)
  })

  test('distância e origem da rota passam intactas para a resposta', async () => {
    const q = await quote({ distance: 3210, source: 'haversine' })
    expect(q.distanceM).toBe(3210)
    expect(q.routeSource).toBe('haversine')
    const o = await quote({ distance: 1, source: 'osrm' })
    expect(o.routeSource).toBe('osrm')
  })
})

// ===========================================================================================================
describe('adicional noturno', () => {
  test('às 23:30 (relógio da cidade, já dia seguinte em UTC) soma 3.00; ao meio-dia não', async () => {
    const night = await quote({ at: NIGHT })
    expect(night.totalBrl).toBe(13)
    expect(line(night, 'night_surcharge')?.amountBrl).toBe(3)
    const noon = await quote({ at: NOON })
    expect(noon.totalBrl).toBe(10)
    expect(line(noon, 'night_surcharge')).toBeUndefined()
  })

  test('vale nas duas cidades e nos três kinds', async () => {
    for (const [p, d] of [[Q1, Q2], [A1, A2]] as const) {
      for (const kind of ['delivery', 'courier', 'ride'] as const) {
        const m = kind === 'delivery' ? await merchant({ city: p.city, country: p.country, lat: p.lat, lng: p.lng }) : null
        const q = await quote({ kind, pickup: p, dropoff: d, at: NIGHT, merchant: m })
        expect(line(q, 'night_surcharge')?.amountBrl, `${p.city}/${kind}`).toBe(3)
      }
    }
  })

  test('a janela é [from, to): 23:00:00 entra, 22:59:59 não; e atravessa a meia-noite (04:59:59 entra, 05:00:00 não)', async () => {
    // O serviço fecha à meia-noite, então o trecho 00:00-05:00 só existe com o horário alargado: usamos 24 h na transação.
    await db.query(
      `update public.settings set value = jsonb_set(value, '{quarai,courier}', '{"opens":"00:00","closes":"00:00"}') where key = 'service_hours'`,
    )
    const at = (hms: string) => quote({ at: `2099-06-10T${hms}-03:00` })
    expect(line(await at('22:59:59'), 'night_surcharge')).toBeUndefined()
    expect(line(await at('23:00:00'), 'night_surcharge')?.amountBrl).toBe(3)
    expect(line(await at('23:59:59'), 'night_surcharge')?.amountBrl).toBe(3)
    expect(line(await at('00:00:00'), 'night_surcharge')?.amountBrl).toBe(3)
    expect(line(await at('04:59:59'), 'night_surcharge')?.amountBrl).toBe(3)
    expect(line(await at('05:00:00'), 'night_surcharge')).toBeUndefined()
  })

  test('janela comum (sem cruzar a meia-noite) e janela vazia (from = to): sem surpresa', async () => {
    await newRule('quarai', 'courier', { nightFrom: '20:00', nightTo: '22:00' })
    const at = (hms: string) => quote({ at: `2099-06-10T${hms}-03:00` })
    expect(line(await at('19:59:59'), 'night_surcharge')).toBeUndefined()
    expect(line(await at('20:00:00'), 'night_surcharge')?.amountBrl).toBe(3)
    expect(line(await at('21:59:59'), 'night_surcharge')?.amountBrl).toBe(3)
    expect(line(await at('22:00:00'), 'night_surcharge')).toBeUndefined()
    // from = to: nenhuma sobretaxa, em vez de cobrar o dia inteiro por engano
    await newRule('artigas', 'courier', { nightFrom: '23:00', nightTo: '23:00' })
    const q = await quote({ pickup: A1, dropoff: A2, at: NIGHT })
    expect(line(q, 'night_surcharge')).toBeUndefined()
  })

  test('adicional noturno configurado em zero não gera linha', async () => {
    await newRule('quarai', 'courier', { night: 0 })
    expect(line(await quote({ at: NIGHT }), 'night_surcharge')).toBeUndefined()
  })
})

// ===========================================================================================================
describe('travessia da fronteira', () => {
  test('BR → UY soma a travessia de 8.00 e marca crossesBorder; UY → BR também', async () => {
    const a = await quote({ pickup: Q1, dropoff: A1 })
    expect(a.crossesBorder).toBe(true)
    expect(a.totalBrl).toBe(18)
    expect(line(a, 'cross_border_fee')?.amountBrl).toBe(8)
    const b = await quote({ pickup: A1, dropoff: Q1 })
    expect(b.crossesBorder).toBe(true)
    expect(line(b, 'cross_border_fee')?.amountBrl).toBe(8)
  })

  test('mesma cidade e mesmo país: sem travessia, crossesBorder falso', async () => {
    for (const [p, d] of [[Q1, Q2], [A1, A2]] as const) {
      const q = await quote({ pickup: p, dropoff: d })
      expect(q.crossesBorder).toBe(false)
      expect(line(q, 'cross_border_fee')).toBeUndefined()
    }
  })

  test('ride cruzando soma 12.00, não 8.00', async () => {
    const q = await quote({ kind: 'ride', pickup: Q1, dropoff: A1 })
    expect(q.totalBrl).toBe(22)
    expect(q.crossesBorder).toBe(true)
    expect(line(q, 'passenger_cross_border_fee')?.amountBrl).toBe(12)
    expect(line(q, 'cross_border_fee')).toBeUndefined()
    expect(q.breakdown.reduce((s, l) => s + l.amountBrl, 0)).not.toBe(18)
  })

  test('courier cruzando usa a taxa de encomenda, não a de passageiro', async () => {
    const q = await quote({ kind: 'courier', pickup: A1, dropoff: Q1 })
    expect(line(q, 'cross_border_fee')?.amountBrl).toBe(8)
    expect(line(q, 'passenger_cross_border_fee')).toBeUndefined()
  })

  test('a ponte nunca é limitada por horário: cruzar às 23:30 é aceito (com o noturno), cruzar ao meio-dia também', async () => {
    const late = await quote({ pickup: Q1, dropoff: A1, at: NIGHT })
    expect(late.blocked).toBe(false)
    expect(late.totalBrl).toBe(21) // 10 + 8 + 3
    expect((await quote({ pickup: A1, dropoff: Q1, at: NOON })).blocked).toBe(false)
  })

})

// ===========================================================================================================
describe('regra de preço em vigor na data (spec 7, passo 1)', () => {
  test('usa a versão vigente na data, não a mais recente', async () => {
    const seeded = (await db.query<{ id: string }>(
      `select id from public.pricing_rules where city = 'quarai' and kind = 'courier' and valid_to is null`,
    )).rows[0].id
    const next = await newRule('quarai', 'courier', { base: 20, minFare: 20 }, '2099-01-01')

    const before = await quote({ at: '2098-06-10T15:00:00Z' })
    expect(before.pricingRuleId).toBe(seeded)
    expect(before.totalBrl).toBe(10)

    const after = await quote({ at: '2099-06-10T15:00:00Z' })
    expect(after.pricingRuleId).toBe(next)
    expect(after.totalBrl).toBe(20)
  })

  test('a virada é no relógio da cidade: 31/12 às 23:30 local (já 01/01 em UTC) ainda é a regra antiga; fim exclusivo', async () => {
    const seeded = (await db.query<{ id: string }>(
      `select id from public.pricing_rules where city = 'quarai' and kind = 'courier' and valid_to is null`,
    )).rows[0].id
    const next = await newRule('quarai', 'courier', { base: 20, minFare: 20, night: 0 }, '2099-01-01')
    expect((await quote({ at: '2099-01-01T02:30:00Z' })).pricingRuleId).toBe(seeded) // 2098-12-31 23:30 -03
    expect((await quote({ at: '2099-01-01T09:00:00Z' })).pricingRuleId).toBe(next) // 2099-01-01 06:00 -03
  })

  test('a regra é a da cidade de ORIGEM e do kind pedido', async () => {
    const qr = await newRule('quarai', 'ride', { base: 30, minFare: 30, passengerCrossBorder: 12 })
    const art = (await db.query<{ id: string }>(
      `select id from public.pricing_rules where city = 'artigas' and kind = 'ride' and valid_to is null`,
    )).rows[0].id
    const fromQ = await quote({ kind: 'ride', pickup: Q1, dropoff: A1 })
    expect(fromQ.pricingRuleId).toBe(qr)
    expect(fromQ.totalBrl).toBe(42) // 30 + 12
    const fromA = await quote({ kind: 'ride', pickup: A1, dropoff: Q1 })
    expect(fromA.pricingRuleId).toBe(art)
    expect(fromA.totalBrl).toBe(22) // 10 + 12
    // o kind courier da mesma cidade continua com a regra padrão
    expect((await quote({ kind: 'courier', pickup: Q1, dropoff: Q2 })).totalBrl).toBe(10)
  })

  test('sem regra em vigor na data o erro é explícito (configuração quebrada), nunca um preço inventado', async () => {
    const r = await refused({ at: '2020-01-01T15:00:00Z' })
    expect(r.code).toBe('55000')
    expect(r.message).toMatch(/pricing_rules[\s\S]*quarai[\s\S]*courier/)
  })
})

// ===========================================================================================================
describe('zonas (spec 6.3)', () => {
  test('destino em zona com is_served falso retorna blocked com a mensagem da zona, sem levantar exceção', async () => {
    await zone({ city: 'quarai', polygon: square(Q2), served: false, notes: 'Zona rural: ligue para combinar a entrega.' })
    const q = await quote({ pickup: Q1, dropoff: Q2 })
    expect(q.blocked).toBe(true)
    expect(q.blockedReason).toBe('Zona rural: ligue para combinar a entrega.')
    expect(q.blockedCode).toBe('zone_not_served')
    expect(q.totalBrl).toBe(0)
    expect(q.breakdown).toEqual([])
    expect(q.pricingRuleId).toEqual(expect.any(String))
  })

  test('sem mensagem na zona, usa a mensagem padrão editável de settings', async () => {
    await zone({ city: 'quarai', polygon: square(Q2), served: false, notes: '   ' })
    const q = await quote({ pickup: Q1, dropoff: Q2 })
    expect(q.blocked).toBe(true)
    expect(q.blockedReason).toBe('Ainda não atendemos esta região.')
    await db.query(
      `update public.settings set value = '{"pt-BR":"Texto novo do admin","es-UY":"x"}' where key = 'unserved_zone_message'`,
    )
    expect((await quote({ pickup: Q1, dropoff: Q2 })).blockedReason).toBe('Texto novo do admin')
  })

  test('ponto fora do polígono não é bloqueado; polígono de outra cidade não vale', async () => {
    await zone({ city: 'quarai', polygon: square(Q2, 0.0005), served: false, notes: 'x' })
    const outside = { ...Q2, lat: Q2.lat + 0.01 }
    expect((await quote({ pickup: Q1, dropoff: outside })).blocked).toBe(false)
    await zone({ city: 'artigas', polygon: square(Q1, 0.0005), served: false, notes: 'y' })
    expect((await quote({ pickup: Q1, dropoff: { ...Q1, lat: Q1.lat + 0.0001 } })).blocked).toBe(false)
  })

  test('um furo no polígono (anel interno) não faz parte da zona', async () => {
    const outer = square(Q2, 0.004).coordinates[0]
    const hole = square(Q2, 0.001).coordinates[0]
    await zone({ city: 'quarai', polygon: { type: 'Polygon', coordinates: [outer, hole] }, served: false, notes: 'anel' })
    const inRing = { ...Q2, lat: Q2.lat + 0.003 }
    expect((await quote({ pickup: Q1, dropoff: inRing })).blocked).toBe(true)
    expect((await quote({ pickup: Q1, dropoff: Q2 })).blocked).toBe(false) // centro: dentro do furo
  })

  test('MultiPolygon: qualquer parte vale', async () => {
    const far = { lat: Q2.lat - 0.02, lng: Q2.lng }
    await zone({
      city: 'quarai', served: false, notes: 'multi',
      polygon: { type: 'MultiPolygon', coordinates: [square(Q2, 0.0005).coordinates, square(far, 0.0005).coordinates] },
    })
    expect((await quote({ pickup: Q1, dropoff: Q2 })).blocked).toBe(true)
    expect((await quote({ pickup: Q1, dropoff: { ...Q1, ...far } })).blocked).toBe(true)
    expect((await quote({ pickup: Q1, dropoff: { ...Q1, lat: Q1.lat + 0.005 } })).blocked).toBe(false)
  })

  test('coleta em zona não atendida também bloqueia', async () => {
    await zone({ city: 'quarai', polygon: square(Q1), served: false, notes: 'coleta fora' })
    const q = await quote({ pickup: Q1, dropoff: Q2 })
    expect(q.blocked).toBe(true)
    expect(q.blockedReason).toBe('coleta fora')
  })

  test('a sobretaxa de zona entra no breakdown como linha própria e soma ao total', async () => {
    await zone({ city: 'quarai', polygon: square(Q2), surcharge: 4.5, served: true })
    const q = await quote({ pickup: Q1, dropoff: Q2, distance: 1500 })
    expect(q.blocked).toBe(false)
    expect(line(q, 'zone_surcharge')).toEqual({ key: 'zone_surcharge', labelKey: 'pricing.zone_surcharge', amountBrl: 4.5 })
    expect(q.totalBrl).toBe(14.5)
  })

  test('zonas sobrepostas: a não atendida vence; entre atendidas vale a maior sobretaxa, uma só linha; coleta e destino não empilham', async () => {
    await zone({ city: 'quarai', polygon: square(Q2, 0.003), surcharge: 2 })
    await zone({ city: 'quarai', polygon: square(Q2, 0.001), surcharge: 6 })
    expect(line(await quote({ pickup: Q1, dropoff: Q2 }), 'zone_surcharge')?.amountBrl).toBe(6)
    await zone({ city: 'quarai', polygon: square(Q1, 0.001), surcharge: 3 })
    const both = await quote({ pickup: Q1, dropoff: Q2 })
    expect(both.breakdown.filter((l) => l.key === 'zone_surcharge')).toHaveLength(1)
    expect(line(both, 'zone_surcharge')?.amountBrl).toBe(6)
    await zone({ city: 'quarai', polygon: square(Q2, 0.0005), served: false, notes: 'vence' })
    expect((await quote({ pickup: Q1, dropoff: Q2 })).blockedReason).toBe('vence')
  })

  test('polígono malformado numa zona da cidade falha FECHADO com erro explícito, não ignora a zona', async () => {
    const id = await zone({ city: 'quarai', polygon: { type: 'Polygon', coordinates: [[[1, 2]]] }, served: false })
    const r = await refused({ pickup: Q1, dropoff: Q2 })
    expect(r.code).toBe('55000')
    expect(r.message).toContain(id)
    await db.query(`update public.zones set polygon = '{"type":"Point","coordinates":[1,2]}' where id = $1`, [id])
    const r2 = await refused({ pickup: Q1, dropoff: Q2 })
    expect(r2.code).toBe('55000')
  })

  test('zona sem polígono (null) não casa com nenhum ponto', async () => {
    await db.query(`insert into public.zones (city, name, polygon, is_served, notes) values ('quarai', 'sem desenho', null, false, 'x')`)
    expect((await quote({ pickup: Q1, dropoff: Q2 })).blocked).toBe(false)
  })
})

// ===========================================================================================================
describe('horário de serviço (06:00 a 00:00), nunca a fronteira', () => {
  test('fora do horário retorna blocked com motivo, sem levantar exceção, em todo kind e cidade', async () => {
    for (const [p, d] of [[Q1, Q2], [A1, A2]] as const) {
      for (const kind of ['courier', 'ride'] as const) {
        const q = await quote({ kind, pickup: p, dropoff: d, at: CLOSED })
        expect(q.blocked, `${p.city}/${kind}`).toBe(true)
        expect(q.blockedCode).toBe('outside_service_hours')
        expect(q.blockedReason).toEqual(expect.stringMatching(/\S/))
        expect(q.totalBrl).toBe(0)
        expect(q.breakdown).toEqual([])
      }
    }
    const { m } = await shop()
    const delivery = await quote({ kind: 'delivery', merchant: m, at: CLOSED })
    expect(delivery.blocked).toBe(true)
    expect(delivery.blockedCode).toBe('outside_service_hours')
  })

  test('as bordas: 05:59:59 fechado, 06:00:00 aberto, 23:59:59 aberto, 00:00:00 fechado', async () => {
    const at = (hms: string, day = '10') => quote({ at: `2099-06-${day}T${hms}-03:00` })
    expect((await at('05:59:59')).blocked).toBe(true)
    expect((await at('06:00:00')).blocked).toBe(false)
    expect((await at('23:59:59')).blocked).toBe(false)
    expect((await at('00:00:00', '11')).blocked).toBe(true)
  })

  test('o relógio é o da cidade, não o do servidor: 02:30Z já é 23:30 (aberto) e 06:30Z é 03:30 (fechado)', async () => {
    expect((await quote({ at: '2099-06-11T02:30:00Z' })).blocked).toBe(false)
    expect((await quote({ at: '2099-06-11T06:30:00Z' })).blocked).toBe(true)
  })

  test('travessia fora do horário é recusada pelo SERVIÇO fechado, e aceita quando aberto: a ponte não é o limite', async () => {
    const closed = await quote({ pickup: Q1, dropoff: A1, at: CLOSED })
    expect(closed.blocked).toBe(true)
    expect(closed.blockedCode).toBe('outside_service_hours')
    expect(closed.crossesBorder).toBe(true)
    expect((await quote({ pickup: Q1, dropoff: A1, at: NOON })).blocked).toBe(false)
  })

  test('a cidade de destino também precisa estar aberta: cada município tem a sua janela', async () => {
    await db.query(
      `update public.settings set value = jsonb_set(value, '{artigas,courier}', '{"opens":"06:00","closes":"22:00"}') where key = 'service_hours'`,
    )
    const q = await quote({ pickup: Q1, dropoff: A1, at: NIGHT }) // 23:30: Quaraí aberto, Artigas já fechado
    expect(q.blocked).toBe(true)
    expect(q.blockedCode).toBe('outside_service_hours')
    expect((await quote({ pickup: Q1, dropoff: Q2, at: NIGHT })).blocked).toBe(false) // só Quaraí: aberto
  })

  test('janela malformada falha FECHADO: o erro sobe, não vira preço nem "aberto"', async () => {
    await db.query(`update public.settings set value = jsonb_set(value, '{quarai,courier}', '{}') where key = 'service_hours'`)
    const r = await refused({ at: NOON })
    expect(r.code).toBe('55000')
    expect(r.message).toMatch(/service_hours/)
  })

  test('dentro do horário nada é bloqueado e blockedReason é nulo', async () => {
    const q = await quote({ at: NOON })
    expect(q.blocked).toBe(false)
    expect(q.blockedReason).toBeNull()
    expect(q.blockedCode).toBeNull()
  })
})

// ===========================================================================================================
describe('delivery: pedido da loja, sem itens, na tarifa de convênio (0031)', () => {
  test('a loja decide a origem: cidade, país e regra vêm do banco, não do pickup que o cliente mandou', async () => {
    const m = await merchant({ city: 'quarai', country: 'BR' })
    const rule = await newRule('quarai', 'delivery', { base: 20, minFare: 20, crossBorder: 8 })
    // o cliente jura que a coleta é em Artigas/UY; o pedido é da loja de Quaraí/BR
    const q = await quote({ kind: 'delivery', merchant: m, pickup: A1, dropoff: Q2 })
    expect(q.pricingRuleId).toBe(rule)
    expect(q.crossesBorder).toBe(false)
    expect(line(q, 'base')?.amountBrl).toBe(20)
    // e cruza de verdade quando o destino está em outro país que o da LOJA
    const across = await quote({ kind: 'delivery', merchant: m, pickup: Q1, dropoff: A1 })
    expect(across.crossesBorder).toBe(true)
    expect(line(across, 'cross_border_fee')?.amountBrl).toBe(8)
  })

  test('delivery exige loja e não aceita itens; courier e ride não aceitam loja nem itens', async () => {
    const s = await shop()
    expect((await refused({ kind: 'delivery', merchant: null })).code).toBe('22023')
    expect((await refused({ kind: 'delivery', merchant: '00000000-0000-4000-8000-0000000000fd' })).code).toBe('22023')
    for (const items of [{}, 'x', 5, [{ itemId: '00000000-0000-4000-8000-0000000000fd', qty: 1 }]]) {
      expect((await refused({ kind: 'delivery', merchant: s.m, items })).code, JSON.stringify(items)).toBe('22023')
    }
    expect((await quote({ kind: 'delivery', merchant: s.m, items: [] })).blocked).toBe(false) // lista vazia é o mesmo que nenhuma
    for (const kind of ['courier', 'ride'] as const) {
      expect((await refused({ kind, merchant: s.m })).code, `${kind} com loja`).toBe('22023')
      expect((await refused({ kind, items: [{ itemId: '00000000-0000-4000-8000-0000000000fd', qty: 1 }] })).code, `${kind} com itens`).toBe('22023')
      expect((await quote({ kind, items: [] })).blocked).toBe(false)
    }
  })

  test('uma loja sem coordenada guardada não tem de onde coletar: recusa em vez de cotar', async () => {
    const m = await merchant()
    await db.query(`update public.merchants set lat = null, lng = null where id = $1`, [m])
    expect((await refused({ kind: 'delivery', merchant: m })).code).toBe('22023')
  })

  test('duas tarifas: a loja paga o convênio e o balcão paga mais, pela mesma corrida; cada uma tem a sua vigência', async () => {
    const m = await merchant()
    const first = await newRule('quarai', 'delivery', { base: 9, minFare: 9 }) // fecha só o convênio, em 2099-01-01
    const agreement = await newRule('quarai', 'delivery', { base: 8, minFare: 8 }, '2099-06-01')
    const shopQuote = await quote({ kind: 'delivery', merchant: m, pickup: Q1, dropoff: Q2, at: NOON })
    expect(shopQuote.audience).toBe('merchant')
    expect(shopQuote.totalBrl).toBe(8)
    expect(shopQuote.pricingRuleId).toBe(agreement)
    expect(first).not.toBe(agreement)
    const courier = await quote({ kind: 'courier', pickup: Q1, dropoff: Q2, at: NOON })
    expect(courier.audience).toBe('client')
    expect(courier.totalBrl).toBe(10)
  })

  test('uma tabela temporária de mesmo nome não muda o preço: nada depende do search_path de quem chama', async () => {
    const s = await shop()
    const honest = await quote({ kind: 'delivery', merchant: s.m })
    await db.query(`create temp table merchants (like public.merchants including all)`)
    await db.query(`insert into pg_temp.merchants select * from public.merchants where id = $1`, [s.m])
    await db.query(`update pg_temp.merchants set lat = null, lng = null, city = 'artigas', country = 'UY'`)
    const q = await quote({ kind: 'delivery', merchant: s.m })
    expect(q.totalBrl).toBe(honest.totalBrl)
    expect(q.crossesBorder).toBe(honest.crossesBorder)
  })
})

// ===========================================================================================================
describe('não há comissão em lugar nenhum da cotação (0019, 0031)', () => {
  const COMMISSION_LIKE = /commission|comiss/i

  test('nenhuma chave nem rótulo do breakdown casa com commission/comiss, e a cotação não tem o campo; a CHECK do pedido a aceitaria', async () => {
    const s = await shop()
    await zone({ city: 'quarai', polygon: square(Q2), surcharge: 2 })
    const cases: Args[] = [
      { kind: 'delivery', merchant: s.m, at: NIGHT },
      { kind: 'delivery', merchant: s.m, pickup: Q1, dropoff: A1 },
      { kind: 'courier', pickup: Q1, dropoff: A1, at: NIGHT },
      { kind: 'ride', distance: 9000 },
    ]
    for (const a of cases) {
      const q = await quote(a)
      expect(q.blocked).toBe(false)
      expect(JSON.stringify(q)).not.toMatch(COMMISSION_LIKE)
      // a mesma regex da CHECK orders_breakdown_no_commission, aplicada pelo banco ao texto do breakdown
      const ok = await db.query(`select not (($1::jsonb)::text ~* '(commission|comiss)') as ok`, [JSON.stringify(q.breakdown)])
      expect(ok.rows[0].ok, JSON.stringify(a)).toBe(true)
    }
  })
})

// ===========================================================================================================
describe('contrato do breakdown', () => {
  const scenarios = async (): Promise<Args[]> => {
    const s = await shop()
    return [
      { kind: 'courier', distance: 0 },
      { kind: 'courier', distance: 4000 },
      { kind: 'courier', pickup: Q1, dropoff: A1, distance: 5333, at: NIGHT },
      { kind: 'ride', pickup: A1, dropoff: Q1, distance: 7777 },
      { kind: 'delivery', merchant: s.m, distance: 3456, at: NIGHT },
      { kind: 'delivery', merchant: s.m, pickup: Q1, dropoff: A1, distance: 9999 },
    ]
  }

  test('o breakdown soma exatamente igual a totalBrl, centavo por centavo', async () => {
    await zone({ city: 'quarai', polygon: square(Q2), surcharge: 1.37 })
    for (const a of await scenarios()) {
      const q = await quote(a)
      expect(q.blocked).toBe(false)
      expect(sumCents(q), JSON.stringify(a)).toBe(cents(q.totalBrl))
      for (const l of q.breakdown) expect(l.amountBrl).toBeGreaterThan(0)
    }
  })

  test('mesmo com o piso, os centavos fecham', async () => {
    await newRule('quarai', 'courier', { base: 3.33, perKm: 0.77, minFare: 9.99 })
    for (const d of [0, 2500, 9000, 20_000]) {
      const q = await quote({ distance: d })
      expect(sumCents(q), `${d} m`).toBe(cents(q.totalBrl))
    }
  })

  test('as linhas de entrega usam as chaves que a view fleet_orders soma', async () => {
    await zone({ city: 'quarai', polygon: square(Q2), surcharge: 2 })
    const keysRow = await db.query<{ keys: string[] }>(`select private.delivery_fee_keys() as keys`)
    const delivery = keysRow.rows[0].keys
    for (const a of await scenarios()) {
      const q = await quote(a)
      for (const l of q.breakdown) expect(delivery, `${l.key} precisa estar em private.delivery_fee_keys()`).toContain(l.key)
      const fee = await db.query<{ fee: string }>(`select private.delivery_fee_brl($1::jsonb) as fee`, [JSON.stringify(q.breakdown)])
      expect(cents(Number(fee.rows[0].fee))).toBe(cents(q.totalBrl))
    }
    // inclui a linha de piso (key base) e a de passageiro
    await newRule('quarai', 'ride', { base: 4, minFare: 10 })
    const r = await quote({ kind: 'ride', pickup: Q1, dropoff: A1 })
    const fee = await db.query<{ fee: string }>(`select private.delivery_fee_brl($1::jsonb) as fee`, [JSON.stringify(r.breakdown)])
    expect(Number(fee.rows[0].fee)).toBe(r.totalBrl)
  })

  test('a resposta tem exatamente os campos do tipo Quote, mais os extras declarados', async () => {
    const q = await quote()
    const quoteKeys: (keyof Quote)[] = [
      'breakdown', 'totalBrl', 'pricingRuleId', 'distanceM', 'routeSource', 'crossesBorder', 'blocked', 'blockedReason',
    ]
    const extraKeys: (keyof Extra)[] = [
      'blockedCode', 'audience', 'fxRateId', 'fxRate', 'fxSpreadPct', 'fxRateUsed', 'fxStale', 'totalUyu',
    ]
    expect(Object.keys(q).sort()).toEqual([...quoteKeys, ...extraKeys].sort())
    expect(typeof q.totalBrl).toBe('number')
    expect(typeof q.distanceM).toBe('number')
    expect(typeof q.pricingRuleId).toBe('string')
    expect(typeof q.crossesBorder).toBe('boolean')
    expect(Array.isArray(q.breakdown)).toBe(true)
  })

  test('a cotação bloqueada tem o mesmo formato, com total 0 e câmbio nulo', async () => {
    const q = await quote({ at: CLOSED })
    expect(Object.keys(q).sort()).toEqual(Object.keys(await quote()).sort())
    expect(q.fxRateId).toBeNull()
    expect(q.totalUyu).toBeNull()
    expect(q.distanceM).toBe(1500)
  })
})

// ===========================================================================================================
describe('conversão para pesos (spec 7, passo 6)', () => {
  test('10 BRL a 7.80 com 5% = exatamente 82 UYU; devolve a taxa, o spread e o id da linha usada', async () => {
    const id = await insertFx('7.800000', '2099-06-10', { spread: '5' })
    const q = await quote()
    expect(q.totalBrl).toBe(10)
    expect(q.totalUyu).toBe(82)
    expect(q.fxRateId).toBe(id)
    expect(q.fxRate).toBe(7.8)
    expect(q.fxSpreadPct).toBe(5)
    expect(q.fxRateUsed).toBe(8.19)
    expect(q.fxStale).toBe(false)
  })

  test('o dia do câmbio é o dia local da cidade: 23:30 de 10/06 usa a taxa de 10/06, não a de 11/06 (UTC)', async () => {
    const d10 = await insertFx('7.800000', '2099-06-10', { spread: '5' })
    await insertFx('9.000000', '2099-06-11', { spread: '5' })
    const q = await quote({ at: NIGHT })
    expect(q.fxRateId).toBe(d10)
    expect(q.fxRate).toBe(7.8)
  })

  test('arredonda peso para CIMA: 13.33 × 8.19 = 109.17 -> 110', async () => {
    await insertFx('7.800000', '2099-06-10', { spread: '5' })
    const q = await quote({ distance: 3333 }) // 13.33
    expect(q.totalBrl).toBe(13.33)
    expect(q.totalUyu).toBe(110)
  })

  test('o override manual vence a linha da API na mesma data', async () => {
    await insertFx('7.800000', '2099-06-10', { spread: '5' })
    const manual = await insertFx('8.000000', '2099-06-10', { spread: '3', manual: true })
    const q = await quote()
    expect(q.fxRateId).toBe(manual)
    expect(q.totalUyu).toBe(83) // 10 × 8.00 × 1.03 = 82.4 -> 83
    expect(q.fxRateUsed).toBe(8.24)
  })

  test('sem linha na data, usa a mais recente ANTERIOR e marca defasada; linha futura não vale', async () => {
    await insertFx('7.700000', '2099-06-05', { spread: '0' })
    const prev = await insertFx('7.750000', '2099-06-07', { spread: '0' })
    await insertFx('9.990000', '2099-06-12', { spread: '0' })
    const q = await quote()
    expect(q.fxRateId).toBe(prev)
    expect(q.fxStale).toBe(true)
    expect(q.fxRate).toBe(7.75)
    expect(q.totalUyu).toBe(78) // 10 × 7.75 = 77.5 -> 78
  })

  test('tabela sem nenhuma linha utilizável cai na taxa de settings (e, sem ela, em 7.80), sem spread, marcada defasada', async () => {
    // 02/01/2026 é anterior a qualquer câmbio real gravado: nenhuma linha vale para essa data
    const at = '2026-01-02T15:00:00Z'
    await db.query(
      `insert into public.settings (key, value, is_public) values ('fx.fallback_rate', '8.25', false)
       on conflict (key) do update set value = excluded.value`,
    )
    const a = await quote({ at })
    expect(a).toMatchObject({ fxRateId: null, fxRate: 8.25, fxSpreadPct: 0, fxStale: true, fxRateUsed: 8.25, totalUyu: 83 })
    for (const bad of ['"lixo"', '0', '-3', 'null']) {
      await db.query(`update public.settings set value = $1::jsonb where key = 'fx.fallback_rate'`, [bad])
      const b = await quote({ at })
      expect(b, bad).toMatchObject({ fxRateId: null, fxRate: 7.8, fxStale: true, totalUyu: 78 })
    }
    await db.query(`delete from public.settings where key = 'fx.fallback_rate'`)
    expect(await quote({ at })).toMatchObject({ fxRate: 7.8, totalUyu: 78 })
  })

  // Uma só resposta para "que taxa vale": a SQL e getEffectiveRate (src/lib/fx/rate.ts) têm de escolher a MESMA
  // linha. As linhas de um teste são inseridas na mesma transação, então empatam em fetched_at: quem desempata
  // o override manual contra a linha da API é a regra de precedência, não a ordem de gravação.
  describe('mesma taxa que getEffectiveRate (TypeScript)', () => {
    const both = async (at: string) => {
      const sql = await quote({ at })
      const ts = await getEffectiveRate(new Date(at), db)
      return { sql, ts }
    }
    const agree = (sql: FullQuote, ts: Awaited<ReturnType<typeof getEffectiveRate>>) => {
      expect(sql.fxRate).toBe(ts.rate)
      expect(sql.fxSpreadPct).toBe(ts.spreadPct)
      expect(sql.fxStale).toBe(ts.isStale)
    }

    test('há linha do mesmo dia: a do dia vence, mesmo existindo uma mais nova que a de ontem', async () => {
      await insertFx('7.600000', '2099-06-09', { spread: '1' })
      await insertFx('7.800000', '2099-06-10', { spread: '5' })
      const { sql, ts } = await both('2099-06-10T15:00:00Z')
      agree(sql, ts)
      expect(sql.fxRate).toBe(7.8)
      expect(sql.fxStale).toBe(false)
    })

    test('a taxa gravada às 06:00 vale numa cotação das 10:00 do mesmo dia (não a de ontem)', async () => {
      await insertFx('7.700000', '2099-06-09', { spread: '2' })
      const today = await insertFx('7.850000', '2099-06-10', { spread: '4' })
      const { sql, ts } = await both('2099-06-10T13:00:00Z') // 10:00 locais
      agree(sql, ts)
      expect(sql.fxRateId).toBe(today)
    })

    test('sem linha do dia: a mais recente anterior, marcada defasada, nos dois lados', async () => {
      await insertFx('7.700000', '2099-06-05', { spread: '0' })
      await insertFx('7.750000', '2099-06-07', { spread: '3' })
      const { sql, ts } = await both('2099-06-10T15:00:00Z')
      agree(sql, ts)
      expect(sql.fxRate).toBe(7.75)
      expect(sql.fxStale).toBe(true)
    })

    test('manual e API no mesmo dia (empatadas em fetched_at): o override manual vence nos dois lados', async () => {
      const api = await insertFx('7.800000', '2099-06-10', { spread: '5' })
      const manual = await insertFx('8.200000', '2099-06-10', { spread: '2', manual: true })
      const tie = await db.query(`select count(distinct fetched_at)::int as n from public.fx_rates where id in ($1, $2)`, [api, manual])
      expect(tie.rows[0].n).toBe(1) // a premissa do teste: as duas empatam em fetched_at
      const { sql, ts } = await both('2099-06-10T15:00:00Z')
      agree(sql, ts)
      expect(sql.fxRateId).toBe(manual)
      expect(sql.fxRate).toBe(8.2)
    })

    test('divergência CONHECIDA e deliberada: só existe linha de data FUTURA. O TS usa a mais recente de qualquer data; a SQL nunca precifica com taxa de depois do dia cotado', async () => {
      const future = await insertFx('9.990000', '2099-06-12', { spread: '0' })
      const { sql, ts } = await both('2099-06-10T15:00:00Z')
      expect(ts.rate).toBe(9.99) // getEffectiveRate: latest of any date
      expect(sql.fxRateId).not.toBe(future) // quote_order: valid_for_date <= day only
      expect(sql.fxStale).toBe(true)
    })
  })

  test('concorda com convertBrlToUyu do TypeScript numa grade de totais, taxas e spreads', async () => {
    const grid: Array<[string, string]> = [
      ['7.800000', '5'], ['7.812345', '4.5'], ['8.800000', '0'], ['7.795500', '2.25'], ['38.123456', '7.5'],
    ]
    const distances = [0, 1500, 2500, 3333, 7777, 12_345, 33_333]
    let day = 1
    for (const [rate, spread] of grid) {
      const date = `2099-08-${String(day++).padStart(2, '0')}`
      await insertFx(rate, date, { spread })
      for (const d of distances) {
        const q = await quote({ distance: d, at: `${date}T15:00:00Z` })
        expect(q.totalUyu, `${q.totalBrl} BRL a ${rate} + ${spread}%`).toBe(convertBrlToUyu(q.totalBrl, Number(rate), Number(spread)))
        expect(Number.isInteger(q.totalUyu)).toBe(true)
      }
    }
  })

  test('o ruído de ponto flutuante não vira um peso a mais: 6.25 BRL a 8.80 sem spread = exatamente 55', async () => {
    await newRule('quarai', 'courier', { base: 6.25, minFare: 0 })
    await insertFx('8.800000', '2099-06-10', { spread: '0' })
    const q = await quote({ distance: 0 })
    expect(q.totalBrl).toBe(6.25)
    expect(q.totalUyu).toBe(55)
    expect(q.totalUyu).toBe(convertBrlToUyu(6.25, 8.8, 0))
  })

  test('delivery: o total em pesos é o da taxa de entrega', async () => {
    await insertFx('7.800000', '2099-06-10', { spread: '5' })
    const s = await shop()
    const q = await quote({ kind: 'delivery', merchant: s.m })
    expect(q.totalBrl).toBe(8) // a tarifa de convênio semeada (0031)
    expect(q.totalUyu).toBe(66) // 8 × 8.19 = 65.52 -> 66
  })
})

// ===========================================================================================================
describe('entradas inválidas falham alto (nunca um preço)', () => {
  test('instante nulo, distância nula, distância negativa e origem da rota nula levantam', async () => {
    const base = params({})
    for (const [label, idx, value] of [
      ['instante nulo', 5, null], ['distância nula', 6, null], ['distância negativa', 6, -1], ['rota nula', 7, null],
    ] as const) {
      const p = [...base]
      p[idx] = value
      const r = await attempt(db, SQL_CALL(FN), p)
      expect(r.ok, label).toBe(false)
      expect(['22023', '22004'], label).toContain(!r.ok && r.code)
    }
    const nullKind = await attempt(db, SQL_CALL(FN), [null, ...base.slice(1)])
    expect(nullKind.ok).toBe(false)
    const nullPickup = await attempt(db, SQL_CALL(FN), [base[0], null, ...base.slice(2)])
    expect(nullPickup.ok).toBe(false)
  })

  test('cidade desconhecida, país inválido, coordenada ausente ou fora do globo levantam 22023', async () => {
    const cases: Array<[string, Args]> = [
      ['cidade com acento', { pickup: { ...Q1, city: 'Quaraí' } }],
      ['cidade desconhecida', { dropoff: { ...Q2, city: 'rivera' } }],
      ['cidade e país que se contradizem', { dropoff: { ...Q2, country: 'UY' } }],
      ['país minúsculo', { dropoff: { ...Q2, country: 'br' } }],
      ['sem lat', { pickup: { city: 'quarai', country: 'BR', lng: -56.4 } }],
      ['lat string', { pickup: { ...Q1, lat: '-30.37' } }],
      ['lat fora do globo', { pickup: { ...Q1, lat: -91 } }],
      ['lng fora do globo', { dropoff: { ...Q2, lng: 181 } }],
      ['pickup não objeto', { pickup: [] as unknown as Record<string, unknown> }],
    ]
    for (const [label, a] of cases) expect((await refused(a)).code, label).toBe('22023')
  })
})

// ===========================================================================================================
describe('permissões e blindagem', () => {
  const SIG = 'public.order_kind, jsonb, jsonb, uuid, jsonb, timestamp with time zone, integer, public.route_source'
  const sig = () => `${FN}(${SIG})`

  test('authenticated e anon NÃO podem executar; service_role pode (distância é entrada, então não é API aberta)', async () => {
    const r = await db.query<{ a: boolean; n: boolean; s: boolean }>(
      `select has_function_privilege('authenticated', to_regprocedure($1), 'execute') as a,
              has_function_privilege('anon', to_regprocedure($1), 'execute') as n,
              has_function_privilege('service_role', to_regprocedure($1), 'execute') as s`,
      [sig()],
    )
    expect(r.rows[0]).toEqual({ a: false, n: false, s: true })
    // quem tem EXECUTE explícito: nunca PUBLIC (grantee 0), nunca anon nem authenticated
    const g = await db.query<{ who: string }>(
      `select coalesce(nullif(a.grantee, 0)::regrole::text, 'PUBLIC') as who
         from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.oid = to_regprocedure($1) and a.privilege_type = 'EXECUTE'`,
      [sig()],
    )
    const who = g.rows.map((x) => x.who)
    expect(who).not.toContain('PUBLIC')
    expect(who).not.toContain('anon')
    expect(who).not.toContain('authenticated')
    expect(who).toContain('service_role')
  })

  test('de fato: um papel de API que tenta chamar recebe permissão negada (42501)', async () => {
    for (const role of ['authenticated', 'anon']) {
      await db.query('savepoint r')
      await db.query(`set local role ${role}`)
      const r = await attempt(db, SQL_CALL(FN), params({}))
      await db.query('rollback to savepoint r')
      expect(r.ok, role).toBe(false)
      expect(!r.ok && r.code, role).toBe('42501')
    }
  })

  test('o caminho real da Server Action funciona: service_role chama e recebe a cotação (sem acesso direto às tabelas)', async () => {
    await db.query('savepoint r')
    await db.query('set local role service_role')
    const r = await attempt(db, SQL_CALL(FN), params({ kind: 'ride', pickup: Q1, dropoff: A1 }))
    await db.query('rollback to savepoint r')
    expect(r.ok).toBe(true)
    const q = (r.ok ? r.rows[0].q : null) as FullQuote
    expect(q.totalBrl).toBe(22)
  })

  test('é SECURITY DEFINER com search_path vazio, e nenhuma referência depende do search_path de quem chama', async () => {
    const r = await db.query<{ secdef: boolean; cfg: string[] }>(
      `select prosecdef as secdef, proconfig as cfg from pg_proc where oid = to_regprocedure($1)`, [sig()],
    )
    expect(r.rows[0].secdef).toBe(true)
    expect(r.rows[0].cfg).toContain('search_path=""')
    // com um search_path hostil de quem chama o resultado é o mesmo
    await db.query(`create schema hostil`)
    await db.query(`create table hostil.pricing_rules (like public.pricing_rules including all)`)
    await db.query(`set local search_path = hostil, public`)
    const q = await quote()
    expect(q.totalBrl).toBe(10)
  })
})
