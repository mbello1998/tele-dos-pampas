// A parte pura da criação de pedido: tipos, validação do que chega do navegador, o que volta para ele e a
// tradução das recusas do banco. Sem rede e sem next/*, para ser testável em Node (tests/unit/order-core.test.ts).
// As Server Actions (src/actions/orders.ts) só costuram isto ao banco.
//
// O QUE O NAVEGADOR MANDA: intenção (tipo, ids de endereço, forma de pagamento) e o total que ele VIU. Nunca
// preço, distância, coordenada nem papel: preço vem do banco, distância do servidor, coordenada da linha de
// `addresses` do próprio cliente, papel da sessão. A entrega da LOJA (`delivery`) não passa por aqui: tem a
// própria ação (src/actions/shop-delivery.ts) e o próprio parser (src/lib/pricing/shop.ts).
//
// O QUE VOLTA PARA O NAVEGADOR: `CustomerQuote`, um subconjunto escolhido campo a campo. O ServerQuote inteiro
// carrega a comissão da loja e a taxa e o spread de câmbio, e nunca sai do servidor.
import { fmt } from '@/lib/pricing/copy'
import type { Locale } from '@/lib/i18n'
import type { RouteSource } from '@/lib/pricing/types'

export type OrderKind = 'delivery' | 'courier' | 'ride'
export type PaymentMethod = 'dinheiro_brl' | 'dinheiro_uyu' | 'pix'

export const ORDER_KINDS: readonly OrderKind[] = ['delivery', 'courier', 'ride']
/** Os que o cliente final pede na tela de confirmação. `delivery` é da loja: tem tela própria. */
export const CUSTOMER_KINDS: readonly OrderKind[] = ['ride', 'courier']
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['dinheiro_brl', 'dinheiro_uyu', 'pix']

/** O que basta para cotar. */
export type QuoteInput = {
  kind: 'courier' | 'ride'
  pickupAddressId: string
  dropoffAddressId: string
}

export type CreateOrderInput = QuoteInput & {
  paymentMethod: PaymentMethod
  /** Troco: a nota que o cliente vai entregar, na moeda cobrada. */
  changeFor: number | null
  /** O total em reais que o cliente viu (de quoteOrder). O servidor recalcula e compara. */
  clientTotalBrl: number
  /** O total em pesos que o cliente viu; obrigatório ao pagar em dinheiro_uyu. */
  clientTotalUyu: number | null
  notes: string | null
}

/** O preço que o cliente pode ver. Compatível com `PriceSummaryQuote` (src/components/order/PriceSummary.tsx). */
export type CustomerQuote = {
  breakdown: { key: string; labelKey: string; amountBrl: number }[]
  totalBrl: number
  totalUyu: number | null
  pricingRuleId: string
  distanceM: number
  routeSource: RouteSource
  crossesBorder: boolean
  blocked: boolean
  blockedReason: string | null
  fxRateUsed: number | null
  fxStale: boolean | null
}

export type FailureReason =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid_input'
  | 'address_not_found'
  | 'rate_limited'
  | 'merchant_unavailable'
  | 'merchant_closed'
  | 'cross_border_not_accepted'
  | 'outside_service_hours'
  | 'zone_not_served'
  | 'item_unavailable'
  | 'payment_invalid'
  | 'distance_too_long'
  | 'price_changed'
  | 'unknown'

export type Failure = { ok: false; reason: FailureReason; message: string }

export type QuoteResult = { ok: true; quote: CustomerQuote } | Failure

export type CreateOrderResult =
  // `duplicate`: o mesmo pedido já tinha sido enviado há instantes (toque duplo). Não é falha: `code` é o do pedido
  // que já existe e a tela segue para ele, sem criar outro.
  | { ok: true; code: string; totalBrl: number; currencyCharged: 'BRL' | 'UYU'; totalCharged: number; duplicate?: true }
  | (Failure & { currentQuote?: { totalBrl: number; totalUyu: number | null } })

// --- validação do que vem do navegador (entrada não confiável) --------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isMoney = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max

export const MAX_NOTES = 500

/** Devolve a entrada limpa (só os campos conhecidos), ou null. Nada que não esteja na lista atravessa. */
export function parseQuoteInput(raw: unknown): QuoteInput | null {
  if (!isRecord(raw)) return null
  const kind = raw.kind
  if (!CUSTOMER_KINDS.includes(kind as OrderKind)) return null
  if (!isUuid(raw.dropoffAddressId) || !isUuid(raw.pickupAddressId)) return null
  // loja e itens não existem mais em nenhum pedido: quem os mandar está errado ou adulterando
  if (raw.merchantId !== undefined && raw.merchantId !== null) return null
  if (raw.items !== undefined && !(Array.isArray(raw.items) && raw.items.length === 0)) return null
  return { kind: kind as 'courier' | 'ride', pickupAddressId: raw.pickupAddressId, dropoffAddressId: raw.dropoffAddressId }
}

export function parseCreateInput(raw: unknown): CreateOrderInput | null {
  const base = parseQuoteInput(raw)
  if (!base || !isRecord(raw)) return null
  if (!PAYMENT_METHODS.includes(raw.paymentMethod as PaymentMethod)) return null
  if (!isMoney(raw.clientTotalBrl, 1_000_000)) return null
  const changeFor = raw.changeFor ?? null
  if (changeFor !== null && !(isMoney(changeFor, 100_000_000) && changeFor > 0)) return null
  const totalUyu = raw.clientTotalUyu ?? null
  if (totalUyu !== null && !isMoney(totalUyu, 1_000_000_000)) return null
  const notes = raw.notes ?? null
  if (notes !== null && (typeof notes !== 'string' || notes.length > MAX_NOTES)) return null
  return {
    ...base,
    paymentMethod: raw.paymentMethod as PaymentMethod,
    changeFor,
    clientTotalBrl: raw.clientTotalBrl,
    clientTotalUyu: totalUyu,
    notes,
  }
}

// --- o que volta para o navegador ---------------------------------------------------------------------------------

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * O ServerQuote do banco -> o que o cliente pode ver. Campo a campo, de propósito: um campo novo no ServerQuote
 * (a comissão, a taxa de câmbio e o spread já estão lá) NÃO chega ao navegador por esquecimento.
 */
export function toCustomerQuote(q: unknown): CustomerQuote {
  if (!isRecord(q) || !Array.isArray(q.breakdown)) throw new Error('quote_order devolveu algo que não é uma cotação')
  return {
    breakdown: q.breakdown.map((l) => {
      const line = l as Record<string, unknown>
      return { key: String(line.key), labelKey: String(line.labelKey), amountBrl: Number(line.amountBrl) }
    }),
    totalBrl: Number(q.totalBrl),
    totalUyu: num(q.totalUyu),
    pricingRuleId: String(q.pricingRuleId),
    distanceM: Number(q.distanceM),
    routeSource: q.routeSource === 'osrm' ? 'osrm' : 'haversine',
    crossesBorder: q.crossesBorder === true,
    blocked: q.blocked === true,
    blockedReason: typeof q.blockedReason === 'string' ? q.blockedReason : null,
    fxRateUsed: num(q.fxRateUsed),
    fxStale: typeof q.fxStale === 'boolean' ? q.fxStale : null,
  }
}

// --- as recusas, no idioma de quem pede ---------------------------------------------------------------------------

// Vivem aqui (e não em src/lib/i18n) pelo mesmo motivo de src/lib/pricing/copy.ts: as tabelas da camada de tradução
// são de outra tarefa e a paridade de chaves entre elas é testada. Quando as chaves migrarem, basta trocar o lookup.
export const FAILURE_COPY: Record<FailureReason, Record<Locale, string>> = {
  unauthenticated: { 'pt-BR': 'Entre na sua conta para fazer o pedido.', 'es-UY': 'Ingresá a tu cuenta para hacer el pedido.' },
  forbidden: { 'pt-BR': 'Esta conta não pode fazer pedidos.', 'es-UY': 'Esta cuenta no puede hacer pedidos.' },
  invalid_input: { 'pt-BR': 'Os dados do pedido estão incompletos. Revise e tente de novo.', 'es-UY': 'Los datos del pedido están incompletos. Revisá e intentá de nuevo.' },
  address_not_found: { 'pt-BR': 'Não encontramos um dos endereços. Escolha de novo.', 'es-UY': 'No encontramos una de las direcciones. Elegí de nuevo.' },
  rate_limited: { 'pt-BR': 'Você fez pedidos demais em pouco tempo. Espere alguns minutos e tente de novo.', 'es-UY': 'Hiciste demasiados pedidos en poco tiempo. Esperá unos minutos e intentá de nuevo.' },
  merchant_unavailable: { 'pt-BR': 'Esta loja não está recebendo pedidos.', 'es-UY': 'Este local no está recibiendo pedidos.' },
  merchant_closed: { 'pt-BR': 'A loja fechou agora há pouco. Tente mais tarde.', 'es-UY': 'El local acaba de cerrar. Intentá más tarde.' },
  cross_border_not_accepted: { 'pt-BR': 'Esta loja não entrega do outro lado da ponte.', 'es-UY': 'Este local no entrega del otro lado del puente.' },
  outside_service_hours: { 'pt-BR': 'Estamos fora do horário de atendimento. Volte mais tarde.', 'es-UY': 'Estamos fuera del horario de atención. Volvé más tarde.' },
  zone_not_served: { 'pt-BR': 'Ainda não atendemos esta região.', 'es-UY': 'Todavía no atendemos esta zona.' },
  item_unavailable: { 'pt-BR': '"{name}" ficou indisponível. Tire do carrinho e confirme de novo.', 'es-UY': '"{name}" quedó sin disponibilidad. Sacalo del carrito y confirmá de nuevo.' },
  payment_invalid: { 'pt-BR': 'Confira a forma de pagamento e o troco: o troco precisa cobrir o total.', 'es-UY': 'Revisá la forma de pago y el vuelto: el vuelto tiene que cubrir el total.' },
  distance_too_long: { 'pt-BR': 'Este endereço fica longe demais da nossa área de entrega.', 'es-UY': 'Esta dirección queda demasiado lejos de nuestra zona de entrega.' },
  price_changed: { 'pt-BR': 'O preço mudou desde que você viu. Confira o novo total antes de confirmar.', 'es-UY': 'El precio cambió desde que lo viste. Revisá el nuevo total antes de confirmar.' },
  unknown: { 'pt-BR': 'Não foi possível criar o pedido agora. Tente de novo em instantes.', 'es-UY': 'No fue posible crear el pedido ahora. Intentá de nuevo en un momento.' },
}

export function failure(reason: FailureReason, locale: Locale, values: Record<string, string> = {}): Failure {
  return { ok: false, reason, message: fmt(FAILURE_COPY[reason][locale], values) }
}

/** SQLSTATE de create_order / quote_order -> motivo. Código desconhecido é 'unknown': o texto do banco não vai à tela. */
export function reasonFromSqlState(code: string | undefined): FailureReason {
  switch (code) {
    case 'TD001': return 'rate_limited'
    case 'TD002': return 'merchant_unavailable'
    case 'TD003': return 'merchant_closed'
    case 'TD004': return 'cross_border_not_accepted'
    case 'TD005': return 'outside_service_hours'
    case 'TD006': return 'zone_not_served'
    case 'TD007': return 'item_unavailable'
    case 'TD008': return 'payment_invalid'
    case 'TD009': return 'distance_too_long'
    case 'TD010': return 'forbidden'
    case '22023': // entrada malformada que o motor de preço recusou
    case '22004':
      return 'invalid_input'
    default: return 'unknown'
  }
}

/**
 * A recusa do banco como mensagem ao usuário. Em TD007 a mensagem do banco é o NOME do item; em TD006 é o texto da
 * zona (escrito em pt-BR pelas settings ou pelo dono da zona): para o es-UY usamos a tradução das settings quando o
 * texto é o padrão delas, e o texto da zona como está quando é um texto próprio dela.
 */
export function failureFromDatabase(
  err: { code?: string; message?: string },
  locale: Locale,
  unservedZoneMessage: Partial<Record<Locale, string>> | null,
): Failure {
  const reason = reasonFromSqlState(err.code)
  if (reason === 'item_unavailable') return failure(reason, locale, { name: (err.message ?? '').slice(0, 120) })
  if (reason === 'zone_not_served') {
    const zone = (err.message ?? '').trim()
    const isDefault = unservedZoneMessage?.['pt-BR'] !== undefined && zone === unservedZoneMessage['pt-BR']
    const text = isDefault ? unservedZoneMessage?.[locale] : zone
    return text ? { ok: false, reason, message: text.slice(0, 300) } : failure(reason, locale)
  }
  return failure(reason, locale)
}

// --- endereço -> jsonb do banco -----------------------------------------------------------------------------------

export type AddressRow = {
  id: string
  label: string | null
  street_name: string | null
  number: string | null
  complement: string | null
  between_streets: string | null
  reference: string | null
  city: string
  country: string
  lat: number | string | null
  lng: number | string | null
  precision: string | null
}

export type OrderPoint = { lat: number; lng: number }

/** Uma linha de `addresses` -> o objeto que create_order grava. null se faltar coordenada: sem ela não se cota. */
export function addressToJson(row: AddressRow): Record<string, unknown> | null {
  const lat = row.lat === null ? NaN : Number(row.lat)
  const lng = row.lng === null ? NaN : Number(row.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (row.city !== 'quarai' && row.city !== 'artigas') return null
  if (row.country !== 'BR' && row.country !== 'UY') return null
  // a cidade decide o país (Quaraí é BR, Artigas é UY): o país decide a travessia e a moeda, então o par incoerente
  // não segue adiante nem que o seletor de endereço tenha deixado passar (o banco também recusa, em quote_point)
  if ((row.city === 'quarai') !== (row.country === 'BR')) return null
  // street_name sempre segue: sem `street_id` (rua que não está no OpenStreetMap) é o único nome que o motoboy lê
  return {
    addressId: row.id,
    city: row.city,
    country: row.country,
    lat,
    lng,
    label: row.label,
    street_name: row.street_name,
    number: row.number,
    complement: row.complement,
    between_streets: row.between_streets,
    reference: row.reference,
    precision: row.precision,
  }
}
