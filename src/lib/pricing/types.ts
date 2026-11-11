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

/** Why `quote_order` refused to price. `blockedReason` is free text for the zone case and a notice for hours. */
export type QuoteBlockCode = 'outside_service_hours' | 'zone_not_served'

/** Which tariff priced the order: the counter price (client) or the agreement price of a registered shop. */
export type QuoteAudience = 'client' | 'merchant'

/**
 * What `public.quote_order` really returns: the `Quote` above plus the fields only the server should forward.
 * Pick fields before sending to the browser (the fx spread is not the customer's business). There is no
 * commission: the platform takes nothing from the food, and `orders.pricing_breakdown` rejects the word.
 * A blocked quote has `totalBrl` 0, an empty `breakdown` and null fx fields.
 */
export type ServerQuote = Quote & {
  blockedCode: QuoteBlockCode | null
  audience: QuoteAudience
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
