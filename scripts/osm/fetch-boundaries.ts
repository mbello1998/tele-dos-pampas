// Fetches each city's municipal boundary relation once and caches it as a
// committed fixture (scripts/osm/boundaries/<city>.json). Run:
//   npx tsx scripts/osm/fetch-boundaries.ts
// If a relation cannot be fetched after backoff this throws: there is
// deliberately no latitude-split fallback.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { round5 } from '../../src/lib/geo/geometry'
import type { City, LatLng, Polygon } from '../../src/lib/geo/types'
import { overpassQuery, type OverpassNode, type OverpassRelation } from './overpass'

// Quaraí: admin_level 8 municipality. Artigas: admin_level 8 city (the
// department, relation 1617618, is admin_level 4 and is NOT used).
export const BOUNDARY_RELATIONS: Record<City, number> = {
  quarai: 242701,
  artigas: 3443435,
}

const key = (p: OverpassNode) => `${p.lat},${p.lon}`

/** Joins the outer member ways of a relation into one closed ring. */
export function assembleRing(members: { role: string; type: string; geometry?: OverpassNode[] }[]): Polygon {
  const pending = members
    .filter((m) => m.type === 'way' && m.role === 'outer' && m.geometry && m.geometry.length > 1)
    .map((m) => [...(m.geometry as OverpassNode[])])
  if (pending.length === 0) throw new Error('relation has no outer ways')

  let ring = pending.shift() as OverpassNode[]
  while (pending.length > 0) {
    const tail = key(ring[ring.length - 1])
    const idx = pending.findIndex((w) => key(w[0]) === tail || key(w[w.length - 1]) === tail)
    if (idx === -1) break
    const [next] = pending.splice(idx, 1)
    if (key(next[0]) !== tail) next.reverse()
    ring = ring.concat(next.slice(1))
  }
  if (pending.length > 0) throw new Error(`boundary has ${pending.length} unjoined outer ways (multiple rings?)`)
  if (key(ring[0]) !== key(ring[ring.length - 1])) throw new Error('boundary ring is not closed')

  return ring.slice(0, -1).map((p): LatLng => ({ lat: round5(p.lat), lng: round5(p.lon) }))
}

async function main() {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), 'boundaries')
  mkdirSync(outDir, { recursive: true })
  for (const city of Object.keys(BOUNDARY_RELATIONS) as City[]) {
    const id = BOUNDARY_RELATIONS[city]
    const [rel] = await overpassQuery<OverpassRelation>(`[out:json][timeout:120];relation(${id});out geom;`)
    const polygon = assembleRing(rel.members ?? [])
    const file = join(outDir, `${city}.json`)
    writeFileSync(file, JSON.stringify({ city, relationId: id, name: rel.tags?.name, polygon }))
    console.log(`${city}: relation ${id}, ${polygon.length} vertices -> ${file}`)
  }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
