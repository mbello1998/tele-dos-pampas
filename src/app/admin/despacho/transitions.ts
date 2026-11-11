/**
 * Which buttons the console may draw for an order. The rule: never a button the database will refuse. A
 * refusal in front of the operator is a bug in the console, not a validation message.
 *
 * The source of truth is the `status_transitions` table the page just read, not a list copied into the code.
 * The one thing the table cannot say is the ADMIN: it has no admin rows on purpose (transition_order() lets the
 * admin go to any status of the order's own flow, with a reason). So for the admin the flow vocabulary is taken
 * from the table, and the "next step" buttons are the transitions that exist from the current status for
 * whoever would normally make them (the admin acts on behalf of the absent merchant, courier or client).
 *
 * tests/db/transition.test.ts asks the real database, for every kind and status, which targets it accepts and
 * requires exactly this function's answer.
 */
export type OrderKind = 'delivery' | 'courier' | 'ride'
export type OrderStatus =
  | 'criado' | 'aguardando_loja' | 'aguardando_motoboy' | 'em_preparo' | 'pronto' | 'aceito'
  | 'motoboy_chegou' | 'coletado' | 'em_rota' | 'em_viagem' | 'entregue' | 'finalizado' | 'cancelado'
export type UserRole = 'client' | 'courier' | 'merchant' | 'fleet' | 'admin'

export interface TransitionRow {
  kind: OrderKind
  from_status: OrderStatus
  to_status: OrderStatus
  allowed_role: UserRole
}
export interface OrderLike {
  kind: OrderKind
  status: OrderStatus
  courier_id: string | null
}
export interface Targets {
  /** The normal next steps. */
  next: OrderStatus[]
  /** Manual adjustments (admin only): any other status of the flow. */
  other: OrderStatus[]
  /** next + other. */
  all: OrderStatus[]
}

/** Canonical order, so the buttons always come out in the same sequence. */
export const STATUS_ORDER: OrderStatus[] = [
  'criado', 'aguardando_loja', 'aguardando_motoboy', 'em_preparo', 'pronto', 'aceito', 'motoboy_chegou',
  'coletado', 'em_rota', 'em_viagem', 'entregue', 'finalizado', 'cancelado',
]
/** Statuses that imply a courier: transition_order() refuses an admin move into one of them without a courier. */
export const COURIER_STATUSES: readonly OrderStatus[] = [
  'aceito', 'motoboy_chegou', 'coletado', 'em_rota', 'em_viagem', 'entregue', 'finalizado',
]
/** Orders that are over: they leave the active list. */
export const CLOSED_STATUSES: readonly OrderStatus[] = ['entregue', 'finalizado', 'cancelado']

const sortStatuses = (s: Iterable<OrderStatus>): OrderStatus[] => {
  const set = new Set(s)
  return STATUS_ORDER.filter((x) => set.has(x))
}

export function legalTargets(rows: TransitionRow[], order: OrderLike, role: UserRole): Targets {
  const ofKind = rows.filter((r) => r.kind === order.kind)

  if (role !== 'admin') {
    const next = sortStatuses(
      ofKind.filter((r) => r.from_status === order.status && r.allowed_role === role).map((r) => r.to_status),
    )
    return { next, other: [], all: next }
  }

  const vocabulary = new Set<OrderStatus>()
  for (const r of ofKind) {
    vocabulary.add(r.from_status)
    vocabulary.add(r.to_status)
  }
  const reachable = (s: OrderStatus) =>
    s !== order.status && (order.courier_id !== null || !COURIER_STATUSES.includes(s))
  const all = sortStatuses([...vocabulary].filter(reachable))
  // Cancelling is always one click away for the admin (a courier who falls through after the accept is the
  // everyday case), even where no role in the table can cancel from here.
  const natural = new Set<OrderStatus>(ofKind.filter((r) => r.from_status === order.status).map((r) => r.to_status))
  natural.add('cancelado')
  const next = all.filter((s) => natural.has(s))
  return { next, other: all.filter((s) => !natural.has(s)), all }
}

/** Whether the console offers "assign courier": mirrors assign_courier(), which refuses a closed order. */
export const canAssignCourier = (status: OrderStatus): boolean => !CLOSED_STATUSES.includes(status)

/**
 * Waiting for a courier: no courier yet AND a courier is the one who normally moves it from here. Derived from
 * the table, so it is the same queue the database offers couriers (courier/aguardando_motoboy, ride/criado,
 * delivery/pronto): an unassigned order can only be in those states, because nothing past them is reachable without
 * a courier (transition_order refuses it, for the admin too).
 */
export function awaitingCourier(rows: TransitionRow[], order: OrderLike): boolean {
  return (
    order.courier_id === null &&
    rows.some((r) => r.kind === order.kind && r.from_status === order.status && r.allowed_role === 'courier')
  )
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  criado: 'Criado',
  aguardando_loja: 'Aguardando a loja',
  aguardando_motoboy: 'Aguardando motoboy',
  em_preparo: 'Em preparo',
  pronto: 'Pronto para retirar',
  aceito: 'Aceito pelo motoboy',
  motoboy_chegou: 'Motoboy chegou',
  coletado: 'Coletado',
  em_rota: 'Em rota',
  em_viagem: 'Em viagem',
  entregue: 'Entregue',
  finalizado: 'Finalizado',
  cancelado: 'Cancelado',
}
export const KIND_LABEL: Record<OrderKind, string> = { delivery: 'Entrega da loja', courier: 'Encomenda', ride: 'Moto-táxi' }
