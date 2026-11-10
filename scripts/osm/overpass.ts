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


export type OverpassResponse<T> = {
  elements: T[]
  /** Present when Overpass hit a timeout / out-of-memory and returned a PARTIAL answer with HTTP 200. */
  remark?: string
  osm3s?: { timestamp_osm_base?: string }
}

/** Where a result came from: which mirror answered and the OSM data vintage. */
export type OverpassMeta = { mirror: string; osmBaseTimestamp: string | null }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export type OverpassOptions = {
  endpoints?: string[]
  backoffMs?: number[]
  fetchImpl?: typeof fetch
  /** Progress/provenance log; defaults to console.log. */
  log?: (line: string) => void
}

/**
 * Runs a query and returns elements plus provenance. Fails loudly on a
 * `remark` (truncated answer). A timeout or network error moves on to the
 * next mirror immediately; 429/502/504 back off and retry on the same host.
 */
export async function overpassQueryWithMeta<T>(
  query: string,
  opts: OverpassOptions = {},
): Promise<{ elements: T[]; meta: OverpassMeta }> {
  const endpoints = opts.endpoints ?? OVERPASS_ENDPOINTS
  const backoff = opts.backoffMs ?? BACKOFF_MS
  const doFetch = opts.fetchImpl ?? fetch
  const log = opts.log ?? ((line: string) => console.log(line))
  const failures: string[] = []

  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt <= backoff.length; attempt++) {
      let res: Response
      try {
        res = await doFetch(`${endpoint}?data=${encodeURIComponent(query)}`, {
          method: 'GET',
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (err) {
        // Timeout or network error: do not retry this host, try the next mirror.
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
        failures.push(`${endpoint}: ${timedOut ? 'timeout' : (err as Error).message}`)
        break
      }

      if (res.ok) {
        const body = (await res.json()) as OverpassResponse<T>
        if (body.remark) {
          failures.push(`${endpoint}: truncated answer (remark: ${body.remark})`)
          break
        }
        const meta = { mirror: endpoint, osmBaseTimestamp: body.osm3s?.timestamp_osm_base ?? null }
        log(`overpass: ${endpoint} answered, OSM base ${meta.osmBaseTimestamp ?? 'unknown'}`)
        return { elements: body.elements, meta }
      }

      if (!RETRYABLE.has(res.status)) {
        failures.push(`${endpoint}: HTTP ${res.status} (not retryable)`)
        break
      }
      failures.push(`${endpoint}: HTTP ${res.status}`)
      if (attempt < backoff.length) await sleep(backoff[attempt])
    }
  }
  throw new Error(`Overpass query failed on every mirror:\n${failures.join('\n')}`)
}

export async function overpassQuery<T>(query: string, opts: OverpassOptions = {}): Promise<T[]> {
  return (await overpassQueryWithMeta<T>(query, opts)).elements
}
