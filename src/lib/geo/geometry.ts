import type { LatLng, Polygon } from './types'

/** Ray-casting point-in-polygon. `polygon` is a single closed ring. */
export function pointInPolygon(point: LatLng, polygon: Polygon): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]
    const b = polygon[j]
    const crosses =
      a.lat > point.lat !== b.lat > point.lat &&
      point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng
    if (crosses) inside = !inside
  }
  return inside
}

/** Rounds to 5 decimal places (about 1 metre). */
export function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5
}
