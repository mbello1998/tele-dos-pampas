import type { OrderKind } from '@/app/admin/despacho/transitions'

export interface Place {
  /** street_name, never joined through street_id (a street missing from OpenStreetMap has no id). */
  street: string
  number: string
  /** The free-text landmark: what a courier in these towns actually navigates by. */
  reference: string
  lat: number | null
  lng: number | null
}

export interface Call {
  id: string
  code: string
  kind: OrderKind
  /** The status the courier SEES: sent back to the database as the stale-screen guard. */
  status: string
  createdAtMs: number
  /** A shop's name (always) or, once the call is the courier's own, the client's first name. */
  requesterName: string | null
  crossesBorder: boolean
  /** City on the far side of the bridge, for the band. */
  crossesTo: string | null
  /** What the courier earns on this one (the delivery fee), BRL. null when the order carries no fee line. */
  fee: number | null
  pickup: Place
  dropoff: Place
  /** Queue: the one status that takes it, read from status_transitions. null = no button (never one the database refuses). */
  acceptTo: string | null
  /** Own jobs: the legal next steps, read from status_transitions. */
  steps: string[]
  /** Own jobs paid in cash: what to collect. */
  collect: { amount: number; currency: 'BRL' | 'UYU'; changeFor: number | null } | null
}
