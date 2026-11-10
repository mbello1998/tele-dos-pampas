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
  Street,
  StreetDataset,
} from '../../src/lib/geo/types'
import { fetchStreets } from './fetch-streets'
import type { OverpassWay } from './overpass'

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

export function buildDataset(ways: OverpassWay[], boundary: Polygon, city: City): StreetDataset {
  const country = COUNTRY[city]

  // Sorted by OSM id so output does not depend on the order Overpass answers in.
  const named = [...ways]
    .filter((w) => (w.tags?.name ?? '').trim().length > 0 && insideBoundary(w, boundary))
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
    intersections: [...(intersectionsByName.get(name)?.values() ?? [])].sort(
      (a, b) => a.streetName.localeCompare(b.streetName) || byLatLng(a.at, b.at),
    ),
  }))

  return { city, country, streets: streets.filter((s) => s.segments.length > 0), references: [] }
}

async function main() {
  const here = dirname(fileURLToPath(import.meta.url))
  const outDir = join(here, '..', '..', 'public', 'data')
  mkdirSync(outDir, { recursive: true })

  const ways = await fetchStreets(BBOX)
  console.log(`fetched ${ways.length} ways`)

  for (const city of Object.keys(COUNTRY) as City[]) {
    const file = join(here, 'boundaries', `${city}.json`)
    const { polygon } = JSON.parse(readFileSync(file, 'utf8')) as { polygon: Polygon }
    const dataset = buildDataset(ways, polygon, city)
    const out = join(outDir, `${city}.json`)
    writeFileSync(out, JSON.stringify(dataset))
    const bytes = Buffer.byteLength(JSON.stringify(dataset))
    console.log(`${city}: ${dataset.streets.length} streets (${COUNTRY[city]}), ${bytes} bytes -> ${out}`)
  }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
