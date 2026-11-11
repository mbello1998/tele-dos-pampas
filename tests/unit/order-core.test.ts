import { describe, expect, test } from 'vitest'
import {
  addressToJson,
  failureFromDatabase,
  parseCreateInput,
  parseQuoteInput,
  reasonFromSqlState,
  toCustomerQuote,
} from '@/app/(cliente)/pedido/novo/order-core'

const U = (n: number) => `a0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

// o que quote_order devolve de verdade, com tudo o que o navegador NUNCA pode ver
const SERVER_QUOTE = {
  breakdown: [
    { key: 'base', labelKey: 'pricing.base', amountBrl: 10 },
    { key: 'items_subtotal', labelKey: 'pricing.items_subtotal', amountBrl: 74 },
  ],
  totalBrl: 84,
  pricingRuleId: U(1),
  distanceM: 1500,
  routeSource: 'osrm',
  crossesBorder: false,
  blocked: false,
  blockedReason: null,
  blockedCode: null,
  commissionBrl: 9.25,
  fxRateId: U(2),
  fxRate: 7,
  fxSpreadPct: 5,
  fxRateUsed: 7.35,
  fxStale: false,
  totalUyu: 618,
}

describe('toCustomerQuote: o que o navegador recebe', () => {
  test('não carrega comissão, taxa de câmbio base, spread nem ids de câmbio', () => {
    const out = toCustomerQuote(SERVER_QUOTE)
    const text = JSON.stringify(out)
    for (const secret of ['commission', 'comiss', 'fxRateId', 'fxSpreadPct', 'blockedCode', '9.25', '"fxRate"']) {
      expect(text, secret).not.toContain(secret)
    }
    expect(Object.keys(out).sort()).toEqual(
      ['blocked', 'blockedReason', 'breakdown', 'crossesBorder', 'distanceM', 'fxRateUsed', 'fxStale', 'pricingRuleId', 'routeSource', 'totalBrl', 'totalUyu'].sort(),
    )
    expect(out).toMatchObject({ totalBrl: 84, totalUyu: 618, fxRateUsed: 7.35, fxStale: false })
  })

  test('um campo novo no ServerQuote (ou uma linha com campo extra) não atravessa por esquecimento', () => {
    const out = toCustomerQuote({
      ...SERVER_QUOTE,
      margemDaPlataforma: 0.4,
      breakdown: [{ key: 'base', labelKey: 'pricing.base', amountBrl: 10, commissionBrl: 1 }],
    })
    expect(JSON.stringify(out)).not.toMatch(/margem|commission|comiss/)
  })

  test('uma cotação bloqueada passa com o motivo; algo que não é cotação lança', () => {
    const out = toCustomerQuote({ ...SERVER_QUOTE, blocked: true, blockedReason: 'Fora da área', breakdown: [], totalBrl: 0, totalUyu: null })
    expect(out).toMatchObject({ blocked: true, blockedReason: 'Fora da área', totalUyu: null })
    expect(() => toCustomerQuote(null)).toThrow()
    expect(() => toCustomerQuote({ totalBrl: 1 })).toThrow()
  })
})

const DELIVERY = {
  kind: 'delivery',
  merchantId: U(10),
  items: [{ itemId: U(11), qty: 2, optionIds: [U(12)] }],
  dropoffAddressId: U(20),
}

describe('parseQuoteInput: só intenção atravessa', () => {
  test('descarta preço, total, delta, distância e coordenada mandados pelo navegador', () => {
    const out = parseQuoteInput({
      ...DELIVERY,
      distanceM: 1,
      totalBrl: 0.01,
      dropoff: { lat: 0, lng: 0 },
      items: [{ itemId: U(11), qty: 1, optionIds: [], priceBrl: 0.01, unitPrice: 0, delta: -9 }],
    })
    expect(out).toEqual({
      kind: 'delivery',
      merchantId: U(10),
      items: [{ itemId: U(11), qty: 1, optionIds: [] }],
      pickupAddressId: null,
      dropoffAddressId: U(20),
    })
  })

  test('delivery exige loja e itens; qty inteira de 1 a 99; ids são uuid', () => {
    expect(parseQuoteInput({ ...DELIVERY, merchantId: null })).toBeNull()
    expect(parseQuoteInput({ ...DELIVERY, items: [] })).toBeNull()
    for (const qty of [0, 100, 1.5, '2', NaN, null]) {
      expect(parseQuoteInput({ ...DELIVERY, items: [{ itemId: U(11), qty }] }), String(qty)).toBeNull()
    }
    expect(parseQuoteInput({ ...DELIVERY, items: [{ itemId: 'x', qty: 1 }] })).toBeNull()
    expect(parseQuoteInput({ ...DELIVERY, items: [{ itemId: U(11), qty: 1, optionIds: ['nope'] }] })).toBeNull()
    expect(parseQuoteInput({ ...DELIVERY, dropoffAddressId: 'casa' })).toBeNull()
    expect(parseQuoteInput({ ...DELIVERY, kind: 'drone' })).toBeNull()
    expect(parseQuoteInput(null)).toBeNull()
    expect(parseQuoteInput([DELIVERY])).toBeNull()
  })

  test('courier e ride exigem o endereço de coleta, e não aceitam loja nem itens', () => {
    const base = { kind: 'courier', dropoffAddressId: U(20), pickupAddressId: U(21) }
    expect(parseQuoteInput(base)).toMatchObject({ kind: 'courier', merchantId: null, items: [], pickupAddressId: U(21) })
    expect(parseQuoteInput({ ...base, kind: 'ride' })).not.toBeNull()
    expect(parseQuoteInput({ ...base, pickupAddressId: undefined })).toBeNull()
    expect(parseQuoteInput({ ...base, merchantId: U(10) })).toBeNull()
    expect(parseQuoteInput({ ...base, items: [{ itemId: U(11), qty: 1 }] })).toBeNull()
  })
})

describe('parseCreateInput', () => {
  const good = { ...DELIVERY, paymentMethod: 'pix', changeFor: null, clientTotalBrl: 84, clientTotalUyu: 618, notes: null }
  test('aceita o pedido bem formado', () => {
    expect(parseCreateInput(good)).toMatchObject({ paymentMethod: 'pix', clientTotalBrl: 84, clientTotalUyu: 618, changeFor: null })
  })
  test('recusa total, troco, pagamento e notas malformados', () => {
    for (const bad of [
      { clientTotalBrl: NaN }, { clientTotalBrl: -1 }, { clientTotalBrl: '84' }, { clientTotalBrl: Infinity }, { clientTotalBrl: undefined },
      { paymentMethod: 'cartao' }, { paymentMethod: undefined },
      { changeFor: 0 }, { changeFor: -5 }, { changeFor: NaN }, { changeFor: '10' },
      { clientTotalUyu: -1 }, { clientTotalUyu: 'x' },
      { notes: 'x'.repeat(501) }, { notes: 5 },
    ]) {
      expect(parseCreateInput({ ...good, ...bad }), JSON.stringify(bad)).toBeNull()
    }
  })
  test('o id do cliente e o papel nunca vêm do corpo: não há campo para eles', () => {
    const out = parseCreateInput({ ...good, clientId: U(99), role: 'admin', profile_id: U(99) })
    expect(out).not.toBeNull()
    expect(JSON.stringify(out)).not.toMatch(/clientId|admin|profile_id/)
  })
})

describe('as recusas do banco, no idioma de quem pede', () => {
  test('cada SQLSTATE da create_order tem o seu motivo; o desconhecido não vaza o texto do banco', () => {
    expect(
      ['TD001', 'TD002', 'TD003', 'TD004', 'TD005', 'TD006', 'TD007', 'TD008', 'TD009', 'TD010', '22023', '22004'].map(reasonFromSqlState),
    ).toEqual([
      'rate_limited', 'merchant_unavailable', 'merchant_closed', 'cross_border_not_accepted', 'outside_service_hours',
      'zone_not_served', 'item_unavailable', 'payment_invalid', 'distance_too_long', 'forbidden', 'invalid_input', 'invalid_input',
    ])
    const f = failureFromDatabase({ code: 'XX000', message: 'relation "orders" violates secret_constraint' }, 'pt-BR', null)
    expect(f).toMatchObject({ ok: false, reason: 'unknown' })
    expect(f.message).not.toContain('secret_constraint')
  })

  test('item indisponível diz QUAL item, nos dois idiomas', () => {
    const pt = failureFromDatabase({ code: 'TD007', message: 'Hambúrguer' }, 'pt-BR', null)
    const es = failureFromDatabase({ code: 'TD007', message: 'Hambúrguer' }, 'es-UY', null)
    expect(pt.message).toContain('"Hambúrguer"')
    expect(es.message).toContain('"Hambúrguer"')
    expect(pt.message).not.toBe(es.message)
  })

  test('zona não atendida: o texto da zona vale; o padrão das settings é traduzido', () => {
    const settings = { 'pt-BR': 'Ainda não atendemos esta região.', 'es-UY': 'Todavía no atendemos esta zona.' }
    expect(failureFromDatabase({ code: 'TD006', message: 'Barro Vermelho ainda não tem entrega.' }, 'es-UY', settings).message).toBe(
      'Barro Vermelho ainda não tem entrega.',
    )
    expect(failureFromDatabase({ code: 'TD006', message: settings['pt-BR'] }, 'es-UY', settings).message).toBe(settings['es-UY'])
    expect(failureFromDatabase({ code: 'TD006', message: settings['pt-BR'] }, 'pt-BR', settings).message).toBe(settings['pt-BR'])
    expect(failureFromDatabase({ code: 'TD006', message: '' }, 'es-UY', null).reason).toBe('zone_not_served')
  })
})

describe('addressToJson: sem coordenada não se cota', () => {
  const row = {
    id: U(20), label: 'casa', street_name: 'Rua A', number: '12', complement: null, between_streets: null, reference: 'portão azul',
    city: 'quarai', country: 'BR', lat: '-30.379100', lng: -56.4514, precision: 'quadra',
  }
  test('lat/lng viram número; sem coordenada, cidade ou país válidos, null', () => {
    expect(addressToJson(row)).toMatchObject({ lat: -30.3791, lng: -56.4514, city: 'quarai', country: 'BR', street_name: 'Rua A' })
    expect(addressToJson({ ...row, lat: null })).toBeNull()
    expect(addressToJson({ ...row, lng: null })).toBeNull()
    expect(addressToJson({ ...row, lat: 'abc' })).toBeNull()
    expect(addressToJson({ ...row, city: 'rivera' })).toBeNull()
    expect(addressToJson({ ...row, country: 'AR' })).toBeNull()
  })
  test('cidade e país têm de concordar: o país decide a travessia e a moeda', () => {
    expect(addressToJson({ ...row, city: 'quarai', country: 'UY' })).toBeNull()
    expect(addressToJson({ ...row, city: 'artigas', country: 'BR' })).toBeNull()
    expect(addressToJson({ ...row, city: 'artigas', country: 'UY' })).not.toBeNull()
  })
  test('rua que não está no mapa (sem street_id) segue com o nome digitado e a coordenada', () => {
    const livre = { ...row, street_name: 'Rua que o mapa não tem', street_id: null } as typeof row & { street_id: null }
    expect(addressToJson(livre)).toMatchObject({ street_name: 'Rua que o mapa não tem', lat: -30.3791, lng: -56.4514 })
  })
})
