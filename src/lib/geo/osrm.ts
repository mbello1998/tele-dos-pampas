import type { RouteSource } from '@/lib/pricing/types'
import { haversineMeters } from './distance'
import type { LatLng } from './types'

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving'
const TIMEOUT_MS = 3000
/** Straight line to street-grid distance in a town: applied only to the fallback. */
const URBAN_GRID_FACTOR = 1.35

function parseOsrmDistance(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) return null
  const { code, routes } = body as { code?: unknown; routes?: unknown }
  if (code !== 'Ok' || !Array.isArray(routes) || routes.length === 0) return null
  const first: unknown = routes[0]
  if (typeof first !== 'object' || first === null) return null
  const distance = (first as { distance?: unknown }).distance
  if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0) return null
  return distance
}

async function fetchOsrmMeters(a: LatLng, b: LatLng): Promise<number | null> {
  const controller = new AbortController()
  // The timer covers the body read too, so a stalled body cannot outlive 3 s.
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const url = `${OSRM_BASE}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`
    const res = await fetch(url, { signal: controller.signal })
    if (res.status !== 200) return null
    return parseOsrmDistance(await res.json())
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Driving distance in whole metres. Never throws: any OSRM failure (network,
 * non-200, unusable body, slower than 3 s) falls back to haversine x 1.35.
 */
export async function routeDistance(
  a: LatLng,
  b: LatLng,
): Promise<{ meters: number; source: RouteSource }> {
  try {
    const meters = await fetchOsrmMeters(a, b)
    if (meters !== null) return { meters: Math.round(meters), source: 'osrm' }
  } catch {
    // fall through to the fallback
  }
  return { meters: Math.round(haversineMeters(a, b) * URBAN_GRID_FACTOR), source: 'haversine' }
}
