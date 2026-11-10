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
