import type { LatLng } from './types'

const EARTH_RADIUS_M = 6_371_008.8
const toRad = (deg: number): number => (deg * Math.PI) / 180

/** Great-circle distance in metres (unrounded). Identical points give exactly 0. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  // Rounding can push h marginally past 1 for antipodal points; sqrt/asin would give NaN.
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))))
}
