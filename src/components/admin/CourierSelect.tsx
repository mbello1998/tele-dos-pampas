import { assignCourierForm } from '@/actions/dispatch'

export interface DispatchCourier {
  profile_id: string
  full_name: string | null
  vehicle: string
  base_city: string
  is_online: boolean
  is_available: boolean
  accepts_cross_border: boolean
  accepts_passenger: boolean
  fleet_id: string | null
  fleet_name: string | null
  /** private.effective_radius_km(): the least of the global ceiling, the fleet maximum and the courier's choice. */
  effective_radius_km: string | number | null
}

const inputClass = 'rounded border border-borda bg-transparent px-2 py-1 text-sm'
/** `bg-transparent` num <select> deixa o menu nativo branco com texto branco em vários aparelhos: aqui o fundo
 *  é opaco e as opções são pintadas, em vez do `text-black` solto que havia em cada <option>. */
const selectClass =
  'rounded border border-borda bg-noite px-2 py-1 text-sm text-white [&>option]:bg-noite [&>option]:text-white'

export const courierLabel = (c: DispatchCourier) =>
  [
    c.full_name ?? 'Sem nome',
    c.fleet_name ? `frota ${c.fleet_name}` : 'autônomo',
    c.effective_radius_km === null ? null : `raio ${Number(c.effective_radius_km)} km`,
    c.is_online ? 'online' : 'offline',
    c.is_available ? null : 'ocupado',
    c.accepts_cross_border ? 'cruza a ponte' : null,
  ].filter(Boolean).join(' · ')

/**
 * Hand the order to a courier of the pickup city. The radius shown is the EFFECTIVE one (it comes from
 * dispatch_couriers(), which calls private.effective_radius_km()); this component never reads a courier's own
 * work_radius_km. The courier already on the order is not offered again.
 */
export function CourierSelect({ orderId, status, couriers, currentCourierId }: {
  orderId: string
  /** The status the operator is looking at: the database refuses the assignment if the order has moved on. */
  status: string
  couriers: DispatchCourier[]
  currentCourierId: string | null
}) {
  const options = couriers.filter((c) => c.profile_id !== currentCourierId)
  if (options.length === 0) return <span className="text-sm text-white/60">Nenhum motoboy aprovado nesta cidade.</span>
  return (
    <form action={assignCourierForm} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="order" value={orderId} />
      <input type="hidden" name="from" value={status} />
      <select name="courier" required aria-label="Motoboy" defaultValue="" className={selectClass}>
        <option value="" disabled>{currentCourierId ? 'Trocar motoboy…' : 'Atribuir motoboy…'}</option>
        {options.map((c) => (
          <option key={c.profile_id} value={c.profile_id}>{courierLabel(c)}</option>
        ))}
      </select>
      <input name="note" required aria-label="Motivo da atribuição" placeholder="Motivo (ex.: pedido por rádio)" className={inputClass} />
      <button type="submit" className="rounded border border-white/40 px-2 py-1 text-sm hover:bg-white/10">
        {currentCourierId ? 'Trocar' : 'Atribuir'}
      </button>
    </form>
  )
}
