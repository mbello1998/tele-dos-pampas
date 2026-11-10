import type { BBox } from '../../src/lib/geo/types'
import { overpassQueryWithMeta, type OverpassMeta, type OverpassWay } from './overpass'

export type { OverpassWay } from './overpass'

/** All named highways inside the bbox, with full geometry, plus where they came from. */
export async function fetchStreetsWithMeta(
  bbox: BBox,
): Promise<{ ways: OverpassWay[]; meta: OverpassMeta }> {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`
  const query = `[out:json][timeout:120];(way(${b})["highway"]["name"];);out tags geom;`
  const { elements, meta } = await overpassQueryWithMeta<OverpassWay>(query)
  return { ways: elements, meta }
}

export async function fetchStreets(bbox: BBox): Promise<OverpassWay[]> {
  return (await fetchStreetsWithMeta(bbox)).ways
}
