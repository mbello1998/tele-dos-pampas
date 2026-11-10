// Carrega o que a tela de rastreio mostra, no servidor, COMO O USUÁRIO (a RLS decide o que existe para ele).
// Degradação: o pedido é obrigatório (sem ele não há tela); eventos, posição e provedor de tiles são
// opcionais e, se falharem, a página sai sem eles em vez de quebrar.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { LatLng } from '@/lib/geo/types'
import { isTrackingActive, type EventRow, type PositionRow } from '@/lib/realtime/position'

export type TrackingData = {
  code: string
  kind: 'food' | 'courier' | 'ride'
  status: string
  events: EventRow[]
  position: PositionRow | null
  pickupText: string
  dropoffText: string
  destination: LatLng | null
  tileUrl: string | null
  attribution: string | null
  etaMinutes: number | null
  crossesBorder: boolean
  cancelReason: string | null
}

type Address = Record<string, unknown>

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** "Rua X, 120 - apto 3 (Quaraí)". Tolerante: endereço sem número ou sem cidade ainda vira texto. */
export function addressText(a: Address | null | undefined): string {
  if (!a) return ''
  const street = str(a.street_name)
  const number = str(a.number)
  const complement = str(a.complement)
  const city = a.city === 'quarai' ? 'Quaraí' : a.city === 'artigas' ? 'Artigas' : str(a.city)
  const main = [street, number].filter(Boolean).join(', ')
  return [complement ? `${main} - ${complement}` : main, city && `(${city})`].filter(Boolean).join(' ')
}

export function addressPoint(a: Address | null | undefined): LatLng | null {
  if (!a || a.lat == null || a.lng == null) return null
  const lat = Number(a.lat)
  const lng = Number(a.lng)
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null
}

/** Para onde o cliente espera ver a moto indo: a corrida busca o passageiro; o resto, a entrega. */
export function destinationFor(kind: string, status: string, pickup: LatLng | null, dropoff: LatLng | null): LatLng | null {
  if (kind === 'ride' && status !== 'em_viagem') return pickup ?? dropoff
  return dropoff ?? pickup
}

/** Devolve null quando o pedido não existe OU não é do usuário (a RLS não distingue, de propósito). */
export async function loadTracking(supabase: SupabaseClient, code: string): Promise<TrackingData | null> {
  const { data: order, error } = await supabase
    .from('orders')
    .select('id, code, kind, status, pickup_address, dropoff_address, eta_minutes, crosses_border, cancel_reason')
    .eq('code', code)
    .maybeSingle()
  if (error) throw new Error(`pedido: ${error.message}`)
  if (!order) return null

  const active = isTrackingActive(String(order.status))
  const [events, position, settings] = await Promise.all([
    supabase.from('order_events').select('id, from_status, to_status, created_at').eq('order_id', order.id).order('created_at').order('id'),
    active
      ? supabase
          .from('courier_positions')
          .select('lat, lng, heading, accuracy_m, recorded_at')
          .eq('order_id', order.id)
          .order('recorded_at', { ascending: false })
          .limit(1)
      : Promise.resolve({ data: null }),
    supabase.from('settings').select('key, value').in('key', ['map.tile_url', 'map.tile_attribution']),
  ])

  const setting = (key: string) => {
    const v = settings.data?.find((s) => s.key === key)?.value
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }
  const latest = position.data?.[0]
  const pickup = order.pickup_address as Address
  const dropoff = order.dropoff_address as Address
  return {
    code: String(order.code),
    kind: order.kind,
    status: String(order.status),
    events: (events.data ?? []).map((e) => ({
      id: Number(e.id),
      from_status: e.from_status ?? null,
      to_status: String(e.to_status),
      created_at: String(e.created_at),
    })),
    position: latest
      ? {
          lat: Number(latest.lat),
          lng: Number(latest.lng),
          heading: latest.heading == null ? null : Number(latest.heading),
          accuracy_m: latest.accuracy_m == null ? null : Number(latest.accuracy_m),
          recorded_at: String(latest.recorded_at),
        }
      : null,
    pickupText: addressText(pickup),
    dropoffText: addressText(dropoff),
    destination: destinationFor(order.kind, String(order.status), addressPoint(pickup), addressPoint(dropoff)),
    tileUrl: setting('map.tile_url'),
    attribution: setting('map.tile_attribution'),
    etaMinutes: order.eta_minutes == null ? null : Number(order.eta_minutes),
    crossesBorder: Boolean(order.crosses_border),
    cancelReason: order.cancel_reason ?? null,
  }
}
