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
  /** True when the street lies outside the city's urban boundary (rural road or outlying barrio). */
  outsideUrban?: boolean
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
