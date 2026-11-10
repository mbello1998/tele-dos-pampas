import type { BBox } from '../../src/lib/geo/types'
import { overpassQueryWithMeta, type OverpassElement, type OverpassMeta } from './overpass'

/** Fuel stations, schools, churches, hospitals/clinics, pharmacies, supermarkets, squares and bridges. */
export async function fetchReferencesWithMeta(
  bbox: BBox,
): Promise<{ elements: OverpassElement[]; meta: OverpassMeta }> {
  const b = `(${bbox.south},${bbox.west},${bbox.north},${bbox.east})`
  const query =
    `[out:json][timeout:120];(` +
    `nwr${b}["amenity"~"^(fuel|school|place_of_worship|hospital|clinic|pharmacy)$"];` +
    `nwr${b}["shop"="supermarket"];` +
    `nwr${b}["place"="square"];` +
    `nwr${b}["leisure"="park"]["name"~"Plaza|Praça"];` +
    `way${b}["bridge"]["name"~"Puente|Ponte"];` +
    `);out tags center;`
  return overpassQueryWithMeta<OverpassElement>(query)
}

export async function fetchReferences(bbox: BBox): Promise<OverpassElement[]> {
  return (await fetchReferencesWithMeta(bbox)).elements
}
