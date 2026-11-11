// A parte pura da cotação SEM CONTA: o que a tela manda, o que o servidor aceita e o que volta.
//
// A tela de `/` não tem sessão nem endereço salvo: ela manda duas coordenadas e o tipo de serviço. Então o que
// chega aqui é entrada de ANÔNIMO, e a regra é a mesma do resto do produto: preço é do servidor. O navegador
// manda intenção (tipo e dois pontos); a DISTÂNCIA é calculada no servidor (routeDistance) e o VALOR no banco
// (public.quote_order). Nada de preço, distância ou taxa vindo da tela.
//
// Sem rede e sem next/*: testável em Node, e usável pelo componente de cliente só para os tipos.
import type { City, Country } from '@/lib/geo/types'
import type { QuoteLine, RouteSource } from './types'

/** Os dois serviços que o cliente final pede nesta tela. `delivery` é da loja e tem tela própria. */
export type TripKind = 'ride' | 'courier'
export const TRIP_KINDS: readonly TripKind[] = ['ride', 'courier']

/**
 * Uma ponta da viagem, do jeito que o navegador pode mandar: só o que o motor de preço precisa.
 * Rótulo, referência e precisão ficam NA TELA — eles importam na criação do pedido, não na cotação, e
 * quanto menos campo atravessa a fronteira, menos há para validar.
 */
export type TripPoint = { city: City; country: Country; lat: number; lng: number }

export type TripQuoteInput = { kind: TripKind; pickup: TripPoint; dropoff: TripPoint }

/** O que a tela pode ver da cotação. Sem comissão, sem taxa nem spread de câmbio: ver ServerQuote. */
export type TripQuote = {
  breakdown: QuoteLine[]
  totalBrl: number
  totalUyu: number | null
  /** A regra de tarifa que valeu. Vai à tela (como em CustomerQuote) para que uma dúvida de preço seja rastreável. */
  pricingRuleId: string
  distanceM: number
  routeSource: RouteSource
  crossesBorder: boolean
  blocked: boolean
  blockedReason: string | null
  fxStale: boolean | null
}

export type TripQuoteFailure = { ok: false; reason: TripFailureReason }
export type TripQuoteResult = { ok: true; quote: TripQuote } | TripQuoteFailure

export type TripFailureReason =
  | 'invalid_input'
  | 'outside_service_hours'
  | 'zone_not_served'
  | 'distance_too_long'
  | 'rate_limited'
  | 'unknown'

/**
 * A caixa que contém as duas cidades, com folga para o município de Quaraí (que é grande) e para a zona
 * rural de Artigas. Serve para recusar coordenada de fora antes de chegar ao banco: a função de preço é
 * executada com a chave secreta, e esta tela é aberta a qualquer um.
 */
export const TRIP_BBOX = { south: -31.4, north: -29.4, west: -57.8, east: -55.2 }

const CITY_COUNTRY: Record<City, Country> = { quarai: 'BR', artigas: 'UY' }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function parsePoint(raw: unknown): TripPoint | null {
  if (!isRecord(raw)) return null
  const { city, country, lat, lng } = raw
  if (city !== 'quarai' && city !== 'artigas') return null
  if (CITY_COUNTRY[city] !== country) return null // a cidade decide o país, e o país decide moeda e travessia
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < TRIP_BBOX.south || lat > TRIP_BBOX.north || lng < TRIP_BBOX.west || lng > TRIP_BBOX.east) return null
  return { city, country: country as Country, lat, lng }
}

/** Devolve a entrada limpa (só os campos conhecidos) ou null. Nada fora da lista atravessa. */
export function parseTripQuoteInput(raw: unknown): TripQuoteInput | null {
  if (!isRecord(raw)) return null
  if (!TRIP_KINDS.includes(raw.kind as TripKind)) return null
  const pickup = parsePoint(raw.pickup)
  const dropoff = parsePoint(raw.dropoff)
  if (!pickup || !dropoff) return null
  return { kind: raw.kind as TripKind, pickup, dropoff }
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * O jsonb do banco -> o que a tela pode ver. Campo a campo de propósito: um campo novo no ServerQuote
 * (comissão, taxa e spread de câmbio já estão lá) não chega ao navegador por esquecimento.
 */
export function toTripQuote(q: unknown): TripQuote {
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
    fxStale: typeof q.fxStale === 'boolean' ? q.fxStale : null,
  }
}

/** SQLSTATE de quote_order -> motivo que a tela sabe explicar. Código desconhecido nunca vira texto do banco. */
export function tripReasonFromSqlState(code: string | undefined): TripFailureReason {
  switch (code) {
    case 'TD005':
      return 'outside_service_hours'
    case 'TD006':
      return 'zone_not_served'
    case 'TD009':
      return 'distance_too_long'
    case '22023':
    case '22004':
      return 'invalid_input'
    default:
      return 'unknown'
  }
}
