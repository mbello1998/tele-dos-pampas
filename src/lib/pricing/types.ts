/** Where a distance came from: the OSRM routing service or the haversine fallback. */
export type RouteSource = 'osrm' | 'haversine'

export type QuoteLine = { key: string; labelKey: string; amountBrl: number }

export type Quote = {
  breakdown: QuoteLine[]
  totalBrl: number
  pricingRuleId: string
  distanceM: number
  routeSource: RouteSource
  crossesBorder: boolean
  blocked: boolean
  blockedReason: string | null
}

/** Why `quote_order` refused to price. `blockedReason` is free text for the zone/item cases and a notice for hours. */
export type QuoteBlockCode = 'outside_service_hours' | 'zone_not_served' | 'item_unavailable'

/**
 * What `public.quote_order` really returns: the `Quote` above plus the fields only the server may see.
 * SERVER ONLY, never serialise this to the browser: `commissionBrl` is the platform's commercial term with the
 * shop. Send `Quote` (pick the fields) to the client, write `commissionBrl` to `order_commissions` in
 * create_order, and store in `orders.pricing_breakdown` only `breakdown` (the CHECK rejects the word commission).
 * A blocked quote has `totalBrl` 0, an empty `breakdown` and null fx fields.
 */
export type ServerQuote = Quote & {
  blockedCode: QuoteBlockCode | null
  commissionBrl: number
  /** Null when no `fx_rates` row was usable and the settings/7.80 fallback was applied. */
  fxRateId: string | null
  fxRate: number | null
  fxSpreadPct: number | null
  /** `fxRate` with the spread applied (informational; `totalUyu` is the authoritative amount). */
  fxRateUsed: number | null
  fxStale: boolean | null
  /** `totalBrl` in whole pesos, rounded up. */
  totalUyu: number | null
}
