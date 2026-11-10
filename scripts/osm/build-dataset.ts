// Builds public/data/quarai.json and public/data/artigas.json from live OSM data.
//   npx tsx scripts/osm/build-dataset.ts
// Requires scripts/osm/boundaries/*.json (see fetch-boundaries.ts).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pointInPolygon, round5 } from '../../src/lib/geo/geometry'
import { normalizeStreetName } from '../../src/lib/geo/normalize'
import type {
  BBox,
  DatasetSource,
  City,
  Country,
  Intersection,
  LatLng,
  Polygon,
  Reference,
  Street,
  StreetDataset,
} from '../../src/lib/geo/types'
import { fetchReferencesWithMeta } from './fetch-references'
import { fetchStreetsWithMeta } from './fetch-streets'
import type { OverpassElement, OverpassWay } from './overpass'

export const COUNTRY: Record<City, Country> = { quarai: 'BR', artigas: 'UY' }

// Covers both towns and the bridge between them.
export const BBOX: BBox = { south: -30.44, west: -56.54, north: -30.32, east: -56.38 }

function slug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Beyond this distance from a city centre, an outside-polygon feature is dropped. */
export const MAX_OUTSIDE_KM = 15

export type BuildOptions = {
  /** Both municipal polygons. Enables nearest-city assignment of features outside every polygon. */
  boundaries?: Record<City, Polygon>
  /** Raw `out tags center` elements (amenity/shop/...) to turn into references. */
  references?: OverpassElement[]
  /** Provenance recorded in the dataset (mirror + OSM base timestamp per query). */
  source?: DatasetSource
}

function centroid(polygon: Polygon): LatLng {
  const n = polygon.length
  return {
    lat: polygon.reduce((s, p) => s + p.lat, 0) / n,
    lng: polygon.reduce((s, p) => s + p.lng, 0) / n,
  }
}

function distanceKm(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLng = (b.lng - a.lng) * rad
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

/** The city whose centroid is nearest to `p`, if within MAX_OUTSIDE_KM. */
function nearestCity(p: LatLng, boundaries: Record<City, Polygon>): City | null {
  let best: City | null = null
  let bestKm = Infinity
  for (const city of Object.keys(boundaries) as City[]) {
    const km = distanceKm(p, centroid(boundaries[city]))
    if (km < bestKm) {
      best = city
      bestKm = km
    }
  }
  return bestKm <= MAX_OUTSIDE_KM ? best : null
}

/** A way belongs to a municipality when at least half of its vertices fall inside it. */
function insideBoundary(way: OverpassWay, boundary: Polygon): boolean {
  const geometry = way.geometry ?? []
  if (geometry.length === 0) return false
  const inside = geometry.filter((g) => pointInPolygon({ lat: g.lat, lng: g.lon }, boundary))
  return inside.length * 2 >= geometry.length
}

function roundedSegment(way: OverpassWay): LatLng[] {
  const out: LatLng[] = []
  for (const g of way.geometry ?? []) {
    const p = { lat: round5(g.lat), lng: round5(g.lon) }
    const last = out[out.length - 1]
    if (!last || last.lat !== p.lat || last.lng !== p.lng) out.push(p)
  }
  return out
}

/** True when more than half of the vertices of these ways lie outside the polygon. */
function mostlyOutside(group: OverpassWay[], boundary: Polygon): boolean {
  let total = 0
  let outside = 0
  for (const w of group) {
    for (const g of w.geometry ?? []) {
      total++
      if (!pointInPolygon({ lat: g.lat, lng: g.lon }, boundary)) outside++
    }
  }
  return outside * 2 > total
}

const byLatLng = (a: LatLng, b: LatLng) => a.lat - b.lat || a.lng - b.lng

/** Parts of one name more than this far apart become separate records (1 km). */
export const SPLIT_GAP_M = 1000
/** A split record's hint uses a reference at most this far from the street (500 m). */
export const HINT_REFERENCE_M = 500
/** Highways legitimately run on for kilometres; their names are never split. */
const NEVER_SPLIT = /^(ruta|rodovia)\b/i

const vertices = (ways: OverpassWay[]): LatLng[] =>
  ways.flatMap((w) => (w.geometry ?? []).map((g) => ({ lat: g.lat, lng: g.lon })))

/**
 * Groups the ways of one name into connected parts: ways sharing a coordinate
 * are joined, then parts closer than SPLIT_GAP_M are joined (single linkage).
 * Returns the parts ordered by their lowest OSM id (ways arrive sorted by id).
 */
function splitByGap(name: string, ways: OverpassWay[]): OverpassWay[][] {
  if (ways.length < 2 || NEVER_SPLIT.test(name)) return [ways]
  const parent = ways.map((_, i) => i)
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])))
  const union = (a: number, b: number) => void (parent[find(a)] = find(b))

  const owner = new Map<string, number>()
  ways.forEach((w, i) => {
    for (const g of w.geometry ?? []) {
      const key = `${g.lat},${g.lon}`
      const seen = owner.get(key)
      if (seen === undefined) owner.set(key, i)
      else union(i, seen)
    }
  })

  const pts = ways.map((w) => vertices([w]))
  const near = (a: number, b: number) =>
    pts[a].some((p) => pts[b].some((q) => distanceKm(p, q) * 1000 <= SPLIT_GAP_M))
  for (let i = 0; i < ways.length; i++) {
    for (let j = i + 1; j < ways.length; j++) {
      if (find(i) !== find(j) && near(i, j)) union(i, j)
    }
  }

  const parts = new Map<number, OverpassWay[]>()
  ways.forEach((w, i) => parts.set(find(i), [...(parts.get(find(i)) ?? []), w]))
  return [...parts.values()].sort((a, b) => a[0].id - b[0].id)
}

/**
 * A human-recognisable discriminator for one of several same-named streets:
 * the nearest reference within 500 m, else the nearest crossing street's name.
 */
function nearHintFor(
  segments: LatLng[][],
  references: Reference[],
  intersections: Intersection[],
): string | undefined {
  const pts = segments.flat()
  if (pts.length === 0) return undefined
  let best: Reference | undefined
  let bestM = Infinity
  for (const ref of references) {
    for (const p of pts) {
      const m = distanceKm(p, ref.at) * 1000
      if (m < bestM) {
        bestM = m
        best = ref
      }
    }
  }
  if (best && bestM <= HINT_REFERENCE_M) return best.name

  // Fall back to the crossing street closest to the middle of the street.
  const mid = { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length }
  let hint: string | undefined
  let hintKm = Infinity
  for (const x of intersections) {
    const km = distanceKm(mid, x.at)
    if (km < hintKm) {
      hintKm = km
      hint = x.streetName
    }
  }
  return hint
}

export function buildDataset(
  ways: OverpassWay[],
  boundary: Polygon,
  city: City,
  options: BuildOptions = {},
): StreetDataset {
  const country = COUNTRY[city]

  // Sorted by OSM id so output does not depend on the order Overpass answers in.
  // A way inside this city's polygon is ours. A way inside no polygon at all
  // goes to the nearest city (<= 15 km). A street is flagged outsideUrban when most
  // of its vertices lie outside this city's polygon.
  const named = [...ways]
    .filter((w) => {
      if ((w.tags?.name ?? '').trim().length === 0) return false
      if (insideBoundary(w, boundary)) return true
      const { boundaries } = options
      if (!boundaries || (Object.keys(boundaries) as City[]).some((c) => insideBoundary(w, boundaries[c]))) {
        return false
      }
      const geometry = w.geometry ?? []
      if (geometry.length === 0) return false
      const mid = {
        lat: geometry.reduce((s, g) => s + g.lat, 0) / geometry.length,
        lng: geometry.reduce((s, g) => s + g.lon, 0) / geometry.length,
      }
      if (nearestCity(mid, boundaries) !== city) return false
      return true
    })
    .sort((a, b) => a.id - b.id)

  const groups = new Map<string, OverpassWay[]>()
  for (const w of named) {
    const name = (w.tags?.name as string).trim()
    groups.set(name, [...(groups.get(name) ?? []), w])
  }

  // One record per name, except when a name has parts more than SPLIT_GAP_M
  // apart (distinct streets sharing a name): then one record per part.
  type Record_ = { name: string; ways: OverpassWay[]; id: string }
  const records: Record_[] = []
  const taken = new Set<string>()
  for (const name of [...groups.keys()].sort()) {
    const parts = splitByGap(name, groups.get(name) as OverpassWay[])
    for (const ways of parts) {
      // Stable ids: slug of the full name; a collision (or a 2nd+ part) gets a
      // numeric suffix, assigned in name/OSM-id order so it is deterministic.
      const base = `${city}-${slug(name)}`
      let id = base
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
      taken.add(id)
      records.push({ name, ways, id })
    }
  }

  // Crossings: a raw (unrounded) coordinate shared by ways of different records.
  const recordsAtPoint = new Map<string, { at: LatLng; ids: Set<string> }>()
  for (const rec of records) {
    for (const w of rec.ways) {
      for (const g of w.geometry ?? []) {
        const key = `${g.lat},${g.lon}`
        const entry = recordsAtPoint.get(key) ?? {
          at: { lat: round5(g.lat), lng: round5(g.lon) },
          ids: new Set<string>(),
        }
        entry.ids.add(rec.id)
        recordsAtPoint.set(key, entry)
      }
    }
  }
  const nameById = new Map(records.map((r) => [r.id, r.name]))
  const intersectionsById = new Map<string, Map<string, Intersection>>()
  for (const { at, ids } of recordsAtPoint.values()) {
    if (ids.size < 2) continue
    for (const owner of ids) {
      const bucket = intersectionsById.get(owner) ?? new Map<string, Intersection>()
      for (const other of ids) {
        if (other === owner || nameById.get(other) === nameById.get(owner)) continue
        bucket.set(`${other}@${at.lat},${at.lng}`, {
          streetId: other,
          streetName: nameById.get(other) as string,
          at,
        })
      }
      intersectionsById.set(owner, bucket)
    }
  }

  const references = buildReferences(options.references ?? [], boundary, city, options.boundaries)
  const splitNames = new Set(
    [...records.reduce((m, r) => m.set(r.name, (m.get(r.name) ?? 0) + 1), new Map<string, number>())]
      .filter(([, n]) => n > 1)
      .map(([name]) => name),
  )

  const streets: Street[] = records.map((rec) => {
    const segments = rec.ways.map(roundedSegment).filter((s) => s.length >= 2)
    const intersections = [...(intersectionsById.get(rec.id)?.values() ?? [])].sort(
      (a, b) => a.streetName.localeCompare(b.streetName) || byLatLng(a.at, b.at),
    )
    const hint = splitNames.has(rec.name) ? nearHintFor(segments, references, intersections) : undefined
    return {
      id: rec.id,
      name: rec.name,
      nameNormalized: normalizeStreetName(rec.name),
      city,
      country,
      segments,
      ...(hint ? { nearHint: hint } : {}),
      ...(mostlyOutside(rec.ways, boundary) ? { outsideUrban: true } : {}),
      intersections,
    }
  })

  return {
    city,
    country,
    streets: streets.filter((s) => s.segments.length > 0),
    references,
    ...(options.source ? { source: options.source } : {}),
  }
}

function referenceKind(tags: Record<string, string>): string | null {
  if (tags.amenity === 'fuel') return 'fuel'
  if (tags.amenity === 'school') return 'school'
  if (tags.amenity === 'place_of_worship') return 'church'
  if (tags.amenity === 'hospital') return 'hospital'
  if (tags.amenity === 'clinic') return 'clinic'
  if (tags.amenity === 'pharmacy') return 'pharmacy'
  if (tags.shop === 'supermarket') return 'supermarket'
  if (tags.place === 'square' || tags.leisure === 'park') return 'plaza'
  if (tags.bridge) return 'bridge'
  return null
}

/** Same classification as streets: inside the polygon, else nearest city within 15 km. */
export function buildReferences(
  elements: OverpassElement[],
  boundary: Polygon,
  city: City,
  boundaries?: Record<City, Polygon>,
): Reference[] {
  const refs: Reference[] = []
  for (const el of elements) {
    const tags = el.tags ?? {}
    const name = (tags.name ?? tags.brand ?? tags.operator ?? '').trim()
    const kind = referenceKind(tags)
    const lat = el.lat ?? el.center?.lat
    const lon = el.lon ?? el.center?.lon
    if (!name || !kind || lat === undefined || lon === undefined) continue

    const p = { lat, lng: lon }
    let mine = pointInPolygon(p, boundary)
    if (!mine && boundaries) {
      const inAny = (Object.keys(boundaries) as City[]).some((c) => pointInPolygon(p, boundaries[c]))
      mine = !inAny && nearestCity(p, boundaries) === city
    }
    if (!mine) continue
    refs.push({
      id: `${city}-ref-${el.type[0]}${el.id}`,
      name,
      kind,
      at: { lat: round5(lat), lng: round5(lon) },
      city,
    })
  }
  return refs.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url))
  const outDir = join(here, '..', '..', 'public', 'data')
  mkdirSync(outDir, { recursive: true })

  const { ways, meta: streetsMeta } = await fetchStreetsWithMeta(BBOX)
  const { elements: references, meta: referencesMeta } = await fetchReferencesWithMeta(BBOX)
  const source: DatasetSource = { streets: streetsMeta, references: referencesMeta }
  console.log(`fetched ${ways.length} ways, ${references.length} reference elements`)
  const boundaries = Object.fromEntries(
    (Object.keys(COUNTRY) as City[]).map((c) => [
      c,
      (JSON.parse(readFileSync(join(here, 'boundaries', `${c}.json`), 'utf8')) as { polygon: Polygon }).polygon,
    ]),
  ) as Record<City, Polygon>

  for (const city of Object.keys(COUNTRY) as City[]) {
    const dataset = buildDataset(ways, boundaries[city], city, { boundaries, references, source })
    const out = join(outDir, `${city}.json`)
    writeFileSync(out, JSON.stringify(dataset))
    const bytes = Buffer.byteLength(JSON.stringify(dataset))
    console.log(`${city}: ${dataset.streets.length} streets (${dataset.streets.filter((s) => s.outsideUrban).length} outsideUrban), ${dataset.references.length} references (${COUNTRY[city]}), ${bytes} bytes -> ${out}`)
  }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
