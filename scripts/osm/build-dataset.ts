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
  City,
  Country,
  Intersection,
  LatLng,
  Polygon,
  Reference,
  Street,
  StreetDataset,
} from '../../src/lib/geo/types'
import { fetchStreets } from './fetch-streets'
import { fetchReferences } from './fetch-references'
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

const byLatLng = (a: LatLng, b: LatLng) => a.lat - b.lat || a.lng - b.lng

export function buildDataset(
  ways: OverpassWay[],
  boundary: Polygon,
  city: City,
  options: BuildOptions = {},
): StreetDataset {
  const country = COUNTRY[city]

  // Sorted by OSM id so output does not depend on the order Overpass answers in.
  // A way inside this city's polygon is ours. A way inside no polygon at all
  // goes to the nearest city (<= 15 km) and is flagged outsideUrban.
  const outside = new Set<number>()
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
      outside.add(w.id)
      return true
    })
    .sort((a, b) => a.id - b.id)

  const groups = new Map<string, OverpassWay[]>()
  for (const w of named) {
    const name = (w.tags?.name as string).trim()
    groups.set(name, [...(groups.get(name) ?? []), w])
  }

  // Stable ids: slug of the full name; a collision gets a numeric suffix,
  // assigned in name order so it is deterministic.
  const names = [...groups.keys()].sort()
  const idByName = new Map<string, string>()
  const taken = new Set<string>()
  for (const name of names) {
    const base = `${city}-${slug(name)}`
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    taken.add(id)
    idByName.set(name, id)
  }

  // Crossings: a raw (unrounded) coordinate shared by ways of different names.
  const namesAtPoint = new Map<string, { at: LatLng; names: Set<string> }>()
  for (const [name, group] of groups) {
    for (const w of group) {
      for (const g of w.geometry ?? []) {
        const key = `${g.lat},${g.lon}`
        const entry = namesAtPoint.get(key) ?? {
          at: { lat: round5(g.lat), lng: round5(g.lon) },
          names: new Set<string>(),
        }
        entry.names.add(name)
        namesAtPoint.set(key, entry)
      }
    }
  }
  const intersectionsByName = new Map<string, Map<string, Intersection>>()
  for (const { at, names: here } of namesAtPoint.values()) {
    if (here.size < 2) continue
    for (const owner of here) {
      const bucket = intersectionsByName.get(owner) ?? new Map<string, Intersection>()
      for (const other of here) {
        if (other === owner) continue
        const streetId = idByName.get(other) as string
        bucket.set(`${streetId}@${at.lat},${at.lng}`, { streetId, streetName: other, at })
      }
      intersectionsByName.set(owner, bucket)
    }
  }

  const streets: Street[] = names.map((name) => ({
    id: idByName.get(name) as string,
    name,
    nameNormalized: normalizeStreetName(name),
    city,
    country,
    segments: (groups.get(name) as OverpassWay[]).map(roundedSegment).filter((s) => s.length >= 2),
    ...((groups.get(name) as OverpassWay[]).every((w) => outside.has(w.id)) ? { outsideUrban: true } : {}),
    intersections: [...(intersectionsByName.get(name)?.values() ?? [])].sort(
      (a, b) => a.streetName.localeCompare(b.streetName) || byLatLng(a.at, b.at),
    ),
  }))

  return {
    city,
    country,
    streets: streets.filter((s) => s.segments.length > 0),
    references: buildReferences(options.references ?? [], boundary, city, options.boundaries),
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

  const ways = await fetchStreets(BBOX)
  const references = await fetchReferences(BBOX)
  console.log(`fetched ${ways.length} ways, ${references.length} reference elements`)
  const boundaries = Object.fromEntries(
    (Object.keys(COUNTRY) as City[]).map((c) => [
      c,
      (JSON.parse(readFileSync(join(here, 'boundaries', `${c}.json`), 'utf8')) as { polygon: Polygon }).polygon,
    ]),
  ) as Record<City, Polygon>

  for (const city of Object.keys(COUNTRY) as City[]) {
    const dataset = buildDataset(ways, boundaries[city], city, { boundaries, references })
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
