import { transitionOrderForm } from '@/actions/dispatch'
import {
  legalTargets, STATUS_LABEL, type OrderLike, type OrderStatus, type TransitionRow,
} from '@/app/admin/despacho/transitions'

const inputClass = 'rounded border border-white/25 bg-transparent px-2 py-1 text-sm'
const buttonClass = 'rounded border border-white/40 px-2 py-1 text-sm hover:bg-white/10'

const verb = (to: OrderStatus) => (to === 'cancelado' ? 'Cancelar pedido' : `Marcar: ${STATUS_LABEL[to]}`)

/**
 * Only the buttons the database will accept. The list comes from legalTargets() (the status_transitions rows
 * the page read), so there is no button to refuse: an order with nothing legal to do shows nothing. The admin
 * always needs a reason, so every form carries a required one.
 */
export function TransitionButtons({ order, rows }: { order: OrderLike & { id: string }; rows: TransitionRow[] }) {
  const { next, other } = legalTargets(rows, order, 'admin')
  if (next.length === 0 && other.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      {next.length > 0 ? (
        <form action={transitionOrderForm} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="order" value={order.id} />
          <input name="note" required aria-label="Motivo" placeholder="Motivo (obrigatório)" className={inputClass} />
          {next.map((to) => (
            <button key={to} type="submit" name="to" value={to} className={buttonClass}>
              {verb(to)}
            </button>
          ))}
        </form>
      ) : null}
      {other.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-sm text-white/70">Ajuste manual</summary>
          <form action={transitionOrderForm} className="mt-2 flex flex-wrap items-center gap-2">
            <input type="hidden" name="order" value={order.id} />
            <select name="to" required aria-label="Novo estado" defaultValue="" className={inputClass}>
              <option value="" disabled>Novo estado…</option>
              {other.map((to) => (
                <option key={to} value={to} className="text-black">{STATUS_LABEL[to]}</option>
              ))}
            </select>
            <input name="note" required aria-label="Motivo do ajuste" placeholder="Motivo (obrigatório)" className={inputClass} />
            <button type="submit" className={buttonClass}>Ajustar</button>
          </form>
        </details>
      ) : null}
    </div>
  )
}
