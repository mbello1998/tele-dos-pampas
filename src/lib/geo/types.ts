export type LatLng = { lat: number; lng: number }
export type BBox = { south: number; west: number; north: number; east: number }
export type City = 'quarai' | 'artigas'
export type Country = 'BR' | 'UY'
/** A single closed ring of vertices (the last vertex is not repeated). */
export type Polygon = LatLng[]

/**
 * A crossing: `streetId`/`streetName` identify the OTHER street that meets the
 * owning street at `at`.
 */
export type Intersection = { streetId: string; streetName: string; at: LatLng }

export type Street = {
  id: string
  name: string
  nameNormalized: string
  city: City
  country: Country
  segments: LatLng[][]
  intersections: Intersection[]
  /**
   * True when most of the street's vertices lie outside the polygon used to
   * classify THIS city. The two polygons differ in kind: Quarai's is the whole
   * municipality, Artigas' is the urban area only. So the flag means "outside
   * the polygon used for that city", and for Quarai it can never be true. It
   * is NOT a uniform "rural" measure: it must not drive anything the customer
   * sees, and `zones` remains the only authority on whether an address is served.
   */
  outsideUrban?: boolean
  /**
   * Only set on records split out of a name shared by distinct streets (parts
   * more than 1 km apart): the nearest reference within 500 m, else the nearest
   * crossing street. Lets the UI tell two "Ibirapitá" entries apart.
   */
  nearHint?: string
}

export type Reference = { id: string; name: string; kind: string; at: LatLng; city: City }

/** Where one Overpass answer came from: the mirror and the OSM data vintage. */
export type SourceInfo = { mirror: string; osmBaseTimestamp: string | null }
export type DatasetSource = { streets: SourceInfo; references: SourceInfo }

export type StreetDataset = {
  city: City
  country: Country
  streets: Street[]
  references: Reference[]
  source?: DatasetSource
}
