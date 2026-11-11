import {
  awaitingCourier, canAssignCourier, KIND_LABEL, STATUS_LABEL, type OrderKind, type OrderStatus, type TransitionRow,
} from '@/app/admin/despacho/transitions'
import { CourierSelect, type DispatchCourier } from './CourierSelect'
import { TransitionButtons } from './TransitionButtons'

// street_id may be null (a street missing from OpenStreetMap, typed by the customer): the street is always read
// from street_name, never joined through street_id. For those addresses the free-text reference is the main
// thing a courier has to go on, so it is shown prominently.
type Place = { city?: string; street_name?: string; number?: string; complement?: string; reference?: string } | null
type Shop = { name: string; city: string }

export interface DispatchOrder {
  id: string
  code: string
  kind: OrderKind
  status: OrderStatus
  courier_id: string | null
  fleet_id: string | null
  crosses_border: boolean
  pickup_address: Place
  dropoff_address: Place
  total_charged: number | string
  currency_charged: string
  created_at: string
  status_updated_at: string
  merchant: Shop | Shop[] | null
}

const place = (a: Place) => (a ? [a.street_name, a.number].filter(Boolean).join(', ') || '—' : '—')
const when = (iso: string) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })

function Reference({ at, testId }: { at: Place; testId: string }) {
  const reference = at?.reference?.trim()
  return reference ? <div className="font-semibold text-amber-200" data-testid={testId}>ref.: {reference}</div> : null
}

/** One active order: what it is, where it is, who has it, and only the buttons that are legal. */
export function OrderRow({ order, rows, couriers }: { order: DispatchOrder; rows: TransitionRow[]; couriers: DispatchCourier[] }) {
  const merchant = Array.isArray(order.merchant) ? order.merchant[0] ?? null : order.merchant
  const city = order.pickup_address?.city ?? merchant?.city ?? null
  const courier = couriers.find((c) => c.profile_id === order.courier_id)
  const waiting = awaitingCourier(rows, order)
  // Same boundaries assign_courier() enforces: never offer a courier the database will refuse.
  const candidates = couriers.filter(
    (c) =>
      c.base_city === city &&
      (!order.crosses_border || c.accepts_cross_border) &&
      (order.kind !== 'ride' || c.accepts_passenger),
  )
  return (
    <tr className="border-t border-borda align-top" data-testid="order-row" data-code={order.code} data-status={order.status}>
      <td className="px-2 py-3 font-mono">{order.code}</td>
      <td className="px-2 py-3">
        {KIND_LABEL[order.kind]}
        {merchant ? <div className="text-xs text-white/60">{merchant.name}</div> : null}
      </td>
      <td className="px-2 py-3">
        <span data-testid="status">{STATUS_LABEL[order.status]}</span>
        {waiting ? <div className="text-xs text-amber-300" data-testid="waiting">na fila, sem motoboy</div> : null}
        <div className="text-xs text-white/60">desde {when(order.status_updated_at)}</div>
      </td>
      <td className="px-2 py-3 text-sm">
        <div>{city ?? '—'}: {place(order.pickup_address)}</div>
        <Reference at={order.pickup_address} testId="pickup-reference" />
        <div className="mt-1 text-white/60">para {place(order.dropoff_address)}</div>
        <Reference at={order.dropoff_address} testId="dropoff-reference" />
      </td>
      <td className="px-2 py-3 text-sm" data-testid="courier">
        {order.courier_id ? (courier?.full_name ?? order.courier_id.slice(0, 8)) : '—'}
        {order.courier_id ? <div className="text-xs text-white/60">{order.fleet_id ? 'frota' : 'autônomo'}</div> : null}
      </td>
      <td className="px-2 py-3">
        <div className="flex flex-col gap-3">
          <TransitionButtons order={order} rows={rows} />
          {canAssignCourier(order.status) ? (
            <CourierSelect orderId={order.id} status={order.status} couriers={candidates} currentCourierId={order.courier_id} />
          ) : null}
        </div>
      </td>
    </tr>
  )
}
