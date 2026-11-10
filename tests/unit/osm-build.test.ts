import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDataset } from '../../scripts/osm/build-dataset'
import type { OverpassWay } from '../../scripts/osm/overpass'
import type { City, Polygon, Street } from '@/lib/geo/types'

const root = join(__dirname, '..', '..')
const ways = (
  JSON.parse(readFileSync(join(root, 'tests/fixtures/overpass-sample.json'), 'utf8')) as {
    elements: OverpassWay[]
  }
).elements

function boundary(city: City): Polygon {
  const file = join(root, 'scripts/osm/boundaries', `${city}.json`)
  return (JSON.parse(readFileSync(file, 'utf8')) as { polygon: Polygon }).polygon
}

const quarai = () => buildDataset(ways, boundary('quarai'), 'quarai')
const artigas = () => buildDataset(ways, boundary('artigas'), 'artigas')
const byName = (streets: Street[], name: string) => streets.find((s) => s.name === name)

test('classifica rua pelo polígono do município, não por latitude', () => {
  const q = quarai().streets.map((s) => s.name)
  const a = artigas().streets.map((s) => s.name)

  // Avenida Simões Lopes Neto sits at lat ~ -30.400: a latitude split would
  // call it Uruguayan, but it lies inside Quaraí's polygon.
  expect(q).toContain('Avenida Simões Lopes Neto')
  expect(a).not.toContain('Avenida Simões Lopes Neto')

  // Luis de Grossi sits at lat ~ -30.3896 (north of the old -30.39 cut) but is
  // inside Artigas' polygon.
  expect(a).toContain('Luis de Grossi')
  expect(q).not.toContain('Luis de Grossi')

  // Ways inside neither municipality (Ruta 30, rural) are dropped.
  expect(q).not.toContain('Ruta 30')
  expect(a).not.toContain('Ruta 30')
})

test('todo registro carrega cidade e país coerentes', () => {
  for (const s of quarai().streets) expect([s.city, s.country]).toEqual(['quarai', 'BR'])
  for (const s of artigas().streets) expect([s.city, s.country]).toEqual(['artigas', 'UY'])
  expect(quarai().country).toBe('BR')
  expect(artigas().country).toBe('UY')
})

test('um nome que existe nos dois lados vira dois registros com países diferentes', () => {
  // The bridge is the one real name present on both banks of the border.
  const q = byName(quarai().streets, 'Puente de la Concordia')
  const a = byName(artigas().streets, 'Puente de la Concordia')
  expect(q?.country).toBe('BR')
  expect(a?.country).toBe('UY')
  expect(q?.id).not.toBe(a?.id)
})

test('gera id estável: mesmo input produz mesmo id', () => {
  const first = artigas().streets.map((s) => s.id)
  const second = artigas().streets.map((s) => s.id)
  expect(second).toEqual(first)
  expect(new Set(first).size).toBe(first.length)

  // Independent of the order Overpass happened to return the ways in.
  const reversed = buildDataset([...ways].reverse(), boundary('artigas'), 'artigas')
  const ids = (streets: Street[]) => Object.fromEntries(streets.map((s) => [s.name, s.id]))
  expect(ids(reversed.streets)).toEqual(ids(artigas().streets))
})

test('extrai cruzamentos onde duas ruas compartilham coordenada', () => {
  const { streets } = artigas()
  const julio = byName(streets, '18 de Julio')
  const saravia = byName(streets, 'Aparicio Saravia')
  expect(julio).toBeDefined()
  expect(saravia).toBeDefined()

  const at = { lat: -30.39753, lng: -56.45916 }
  const fromJulio = julio?.intersections.find((i) => i.streetName === 'Aparicio Saravia')
  expect(fromJulio?.streetId).toBe(saravia?.id)
  expect(fromJulio?.at).toEqual(at)

  const fromSaravia = saravia?.intersections.find((i) => i.streetName === '18 de Julio')
  expect(fromSaravia?.streetId).toBe(julio?.id)
  expect(fromSaravia?.at).toEqual(at)

  // Same-named ways that touch each other are not a crossing.
  for (const s of streets) {
    expect(s.intersections.every((i) => i.streetId !== s.id)).toBe(true)
  }
})

test('agrupa segmentos da mesma rua sob um único registro', () => {
  const { streets } = artigas()
  expect(streets.filter((s) => s.name === '18 de Julio')).toHaveLength(1)
  expect(byName(streets, '18 de Julio')?.segments).toHaveLength(4)
  expect(byName(streets, 'Aparicio Saravia')?.segments).toHaveLength(2)
})

test('descarta via sem nome', () => {
  const unnamed: OverpassWay = {
    type: 'way',
    id: 1,
    tags: { highway: 'residential' },
    geometry: ways.find((w) => w.tags?.name === '18 de Julio')?.geometry,
  }
  const { streets } = buildDataset([...ways, unnamed], boundary('artigas'), 'artigas')
  expect(streets.map((s) => s.name)).toEqual(artigas().streets.map((s) => s.name))
  expect(streets.every((s) => s.name.trim().length > 0)).toBe(true)
})

test('nameNormalized vem de normalizeStreetName e coordenadas têm 5 casas', () => {
  const s = byName(quarai().streets, 'Avenida Simões Lopes Neto')
  expect(s?.nameNormalized).toBe('simoes lopes neto')
  for (const street of [...quarai().streets, ...artigas().streets]) {
    for (const p of street.segments.flat()) {
      expect(Math.round(p.lat * 1e5) / 1e5).toBe(p.lat)
      expect(Math.round(p.lng * 1e5) / 1e5).toBe(p.lng)
    }
  }
})
