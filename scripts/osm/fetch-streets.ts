import type { BBox } from '../../src/lib/geo/types'
import { overpassQuery, type OverpassWay } from './overpass'

export type { OverpassWay } from './overpass'

/** All named highways inside the bbox, with full geometry. */
export async function fetchStreets(bbox: BBox): Promise<OverpassWay[]> {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`
  const query = `[out:json][timeout:120];(way(${b})["highway"]["name"];);out tags geom;`
  return overpassQuery<OverpassWay>(query)
}
