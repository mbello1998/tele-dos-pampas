// Minimal Overpass client. Mechanics verified by hand on 2026-11-09:
//  - POST returns 406: use GET with the query in the query string.
//  - A User-Agent header is required (no User-Agent -> 406).
//  - area["name"=...] queries return 502 "at capacity": query by bbox / relation id.
//  - Transient 429/502/504 are common: exponential backoff, mirrors in order.

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
]

export const USER_AGENT = 'tele-dos-pampas-build/1.0'
export const BACKOFF_MS = [2000, 4000, 8000, 16000, 32000]
const REQUEST_TIMEOUT_MS = 130_000
const RETRYABLE = new Set([429, 502, 504])

export type OverpassNode = { lat: number; lon: number }

export type OverpassWay = {
  type: 'way'
  id: number
  tags?: Record<string, string>
  geometry?: OverpassNode[]
}

/** A node/way/relation answered with `out tags center`. */
export type OverpassElement = {
  type: 'node' | 'way' | 'relation'
  id: number
  lat?: number
  lon?: number
  center?: OverpassNode
  tags?: Record<string, string>
}

export type OverpassMember = {
  type: 'node' | 'way' | 'relation'
  ref: number
  role: string
  geometry?: OverpassNode[]
}

export type OverpassRelation = {
  type: 'relation'
  id: number
  tags?: Record<string, string>
  members?: OverpassMember[]
}

export type OverpassResponse<T> = { elements: T[] }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function overpassQuery<T>(
  query: string,
  opts: { endpoints?: string[]; backoffMs?: number[]; fetchImpl?: typeof fetch } = {},
): Promise<T[]> {
  const endpoints = opts.endpoints ?? OVERPASS_ENDPOINTS
  const backoff = opts.backoffMs ?? BACKOFF_MS
  const doFetch = opts.fetchImpl ?? fetch
  const failures: string[] = []

  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt <= backoff.length; attempt++) {
      let status = 0
      try {
        const res = await doFetch(`${endpoint}?data=${encodeURIComponent(query)}`, {
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        status = res.status
        if (res.ok) {
          const body = (await res.json()) as OverpassResponse<T>
          return body.elements
        }
      } catch (err) {
        failures.push(`${endpoint}: ${(err as Error).message}`)
      }
      if (status !== 0 && !RETRYABLE.has(status)) {
        failures.push(`${endpoint}: HTTP ${status} (not retryable)`)
        break
      }
      if (status !== 0) failures.push(`${endpoint}: HTTP ${status}`)
      if (attempt < backoff.length) await sleep(backoff[attempt])
    }
  }
  throw new Error(`Overpass query failed on every mirror:\n${failures.join('\n')}`)
}
