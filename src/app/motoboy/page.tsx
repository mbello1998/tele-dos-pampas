import type { Metadata } from 'next'
import { CallFeed } from '@/components/courier/CallFeed'
import type { Call, Place } from '@/components/courier/types'
import { CLOSED_STATUSES, legalTargets, type OrderKind, type OrderStatus, type TransitionRow } from '@/app/admin/despacho/transitions'
import { requireRole } from '@/lib/auth/session'
import { getLocale } from '@/lib/i18n/server'
import { createClient } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Chamados: Tele dos Pampas', robots: { index: false } }
export const dynamic = 'force-dynamic'

// courier_orders, never orders: a courier's direct SELECT on orders is revoked, and the view carries no price
// structure (no items, no commission, no pricing_breakdown). requester_name is the shop's name, or the client's
// first name ONLY once the call is this courier's own (0032).
const COLUMNS =
  'id, code, kind, status, created_at, crosses_border, courier_id, pickup_address, dropoff_address, delivery_fee_brl, requester_name, payment_method, currency_charged, total_charged, change_for'

type Jsonish = Record<string, unknown> | null
interface Row {
  id: string
  code: string
  kind: OrderKind
  status: OrderStatus
  created_at: string
  crosses_border: boolean
  courier_id: string | null
  pickup_address: Jsonish
  dropoff_address: Jsonish
  delivery_fee_brl: number | string | null
  requester_name: string | null
  payment_method: string
  currency_charged: 'BRL' | 'UYU' | null
  total_charged: number | string | null
  change_for: number | string | null
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

// street_id may be null (a street missing from OpenStreetMap): the street is read from street_name and never
// joined through an id. A shop's pickup has no street, only the address text.
function place(a: Jsonish): Place {
  return {
    street: text(a?.street_name) || text(a?.address_text),
    number: text(a?.number),
    reference: text(a?.reference),
    lat: num(a?.lat),
    lng: num(a?.lng),
  }
}

const CITY_LABEL: Record<string, string> = { quarai: 'Quaraí', artigas: 'Artigas' }

export default async function Motoboy() {
  const session = await requireRole('courier', { next: '/motoboy' })
  const locale = await getLocale()
  const supabase = await createClient()
  const me = session.user.id

  const [orders, transitions, flags, radius] = await Promise.all([
    supabase
      .from('courier_orders')
      .select(COLUMNS)
      .or(`courier_id.is.null,courier_id.eq.${me}`)
      .not('status', 'in', `(${CLOSED_STATUSES.join(',')})`)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase.from('status_transitions').select('kind, from_status, to_status, allowed_role'),
    // the courier's own two boundaries (not the radius: that comes from my_effective_radius_km)
    supabase.from('couriers').select('accepts_cross_border, accepts_passenger').eq('profile_id', me).maybeSingle(),
    supabase.rpc('my_effective_radius_km'),
  ])
  const loadFailed = Boolean(orders.error || transitions.error || flags.error)
  const rows = (transitions.data ?? []) as TransitionRow[]
  const all = (orders.data ?? []) as unknown as Row[]
  const acceptsBridge = flags.data?.accepts_cross_border === true
  const acceptsPassenger = flags.data?.accepts_passenger === true
  const radiusKm = radius.error || radius.data === null ? null : Number(radius.data)

  const toCall = (r: Row, own: boolean): Call => {
    const pickup = place(r.pickup_address)
    const dropoff = place(r.dropoff_address)
    const fee = num(r.delivery_fee_brl)
    const cash = r.payment_method === 'dinheiro_brl' || r.payment_method === 'dinheiro_uyu'
    const total = num(r.total_charged)
    // Both lists come from status_transitions as the database holds it: no button the database would refuse.
    const next = legalTargets(rows, { kind: r.kind, status: r.status, courier_id: r.courier_id }, 'courier').next
    return {
      id: r.id,
      code: r.code,
      kind: r.kind,
      status: r.status,
      createdAtMs: new Date(r.created_at).getTime(),
      requesterName: r.requester_name,
      crossesBorder: r.crosses_border,
      crossesTo: r.crosses_border ? CITY_LABEL[text(r.dropoff_address?.city)] ?? null : null,
      fee: fee !== null && fee > 0 ? fee : null,
      pickup,
      dropoff,
      acceptTo: own ? null : next[0] ?? null,
      steps: own ? next : [],
      collect: own && cash && total !== null ? { amount: total, currency: r.currency_charged ?? 'BRL', changeFor: num(r.change_for) } : null,
    }
  }

  // The queue is the calls nobody has; the screen filter for the courier's own boundaries is a convenience, the
  // database refuses the claim anyway (transition_order, 0032).
  const queue = all
    .filter((r) => r.courier_id === null)
    .filter((r) => acceptsBridge || !r.crosses_border)
    .filter((r) => acceptsPassenger || r.kind !== 'ride')
    .map((r) => toCall(r, false))
    .filter((c) => c.acceptTo !== null)
  const mine = all
    .filter((r) => r.courier_id === me)
    .map((r) => toCall(r, true))
    .sort((a, b) => a.createdAtMs - b.createdAtMs)

  return (
    <main className="mx-auto min-h-dvh w-full max-w-md px-3 pb-16 pt-4">
      <CallFeed queue={queue} mine={mine} radiusKm={radiusKm} serverNow={Date.now()} locale={locale} loadFailed={loadFailed} />
    </main>
  )
}
