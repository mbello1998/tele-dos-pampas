import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildDataset } from '../../scripts/osm/build-dataset'
import type { OverpassElement, OverpassWay } from '../../scripts/osm/overpass'
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

  // Without the `boundaries` option, ways inside neither municipality are dropped:
  // only the 2 Ruta 30 ways that touch Artigas' polygon survive (of 4 in the sample).
  expect(q).not.toContain('Ruta 30')
  expect(byName(artigas().streets, 'Ruta 30')?.segments).toHaveLength(2)
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

const boundaries = { quarai: boundary('quarai'), artigas: boundary('artigas') }
const references = (
  JSON.parse(readFileSync(join(root, 'tests/fixtures/overpass-references.json'), 'utf8')) as {
    elements: OverpassElement[]
  }
).elements

test('via fora dos dois polígonos vai para a cidade mais próxima', () => {
  const q = buildDataset(ways, boundaries.quarai, 'quarai', { boundaries })
  const a = buildDataset(ways, boundaries.artigas, 'artigas', { boundaries })
  expect(q.streets.map((s) => s.name)).not.toContain('Ruta 30')
  const ruta = byName(a.streets, 'Ruta 30')
  expect(ruta?.segments).toHaveLength(4) // all four sample ways, 2 of them outside both polygons
  expect(ruta?.country).toBe('UY')
})

test('outsideUrban: maioria dos vértices fora do polígono, mesmo com um trecho dentro', () => {
  const a = buildDataset(ways, boundaries.artigas, 'artigas', { boundaries })
  // Real Ruta 30: 4 sample ways, one fully and one half inside Artigas' polygon,
  // but 148 of its 155 vertices outside it. An "all ways outside" rule misses it.
  expect(byName(a.streets, 'Ruta 30')?.outsideUrban).toBe(true)
  // Downtown streets are not flagged.
  expect(byName(a.streets, '18 de Julio')?.outsideUrban).toBeUndefined()
  expect(byName(a.streets, 'Aparicio Saravia')?.outsideUrban).toBeUndefined()
})

test('via a mais de 15 km de ambas as cidades é descartada', () => {
  const far: OverpassWay = {
    type: 'way',
    id: 2,
    tags: { name: 'Ruta Lejana', highway: 'secondary' },
    geometry: [
      { lat: -30.9, lon: -56.0 },
      { lat: -30.91, lon: -56.01 },
    ],
  }
  for (const city of ['quarai', 'artigas'] as const) {
    const d = buildDataset([...ways, far], boundaries[city], city, { boundaries })
    expect(d.streets.map((s) => s.name)).not.toContain('Ruta Lejana')
  }
})

const refIds = (d: { references: { id: string }[] }) => new Set(d.references.map((r) => r.id))

test('referências: cada uma cai na cidade certa (dados reais conhecidos)', () => {
  const q = buildDataset(ways, boundaries.quarai, 'quarai', { boundaries, references })
  const a = buildDataset(ways, boundaries.artigas, 'artigas', { boundaries, references })
  expect(q.references.length).toBeGreaterThan(0)
  expect(a.references.length).toBeGreaterThan(0)

  // Quarai-side references: present in Quarai, absent from Artigas.
  const quaraiSide = ['quarai-ref-n9893342124', 'quarai-ref-n4735589623', 'quarai-ref-n5478809762']
  for (const id of quaraiSide) {
    expect(refIds(q)).toContain(id)
    expect(refIds(a)).not.toContain(id.replace('quarai-', 'artigas-'))
  }
  expect(a.references.map((r) => r.name)).not.toContain('Igreja Matriz de Quaraí')
  expect(a.references.map((r) => r.name)).not.toContain('Shell')
  // Artigas-side references: the opposite.
  expect(a.references.map((r) => r.name)).toContain('Hospital Departamental de Artigas')
  expect(q.references.map((r) => r.name)).not.toContain('Hospital Departamental de Artigas')
  expect(q.references.map((r) => r.name)).not.toContain('Plaza Artigas')

  // The bridge exists on both banks.
  expect(q.references.some((r) => r.kind === 'bridge')).toBe(true)
  expect(a.references.some((r) => r.kind === 'bridge')).toBe(true)

  // Total is partitioned: nothing duplicated across cities (84 elements, 1 has no name/brand).
  expect(q.references.length + a.references.length).toBe(83)
  for (const r of q.references) expect(r.city).toBe('quarai')
  for (const r of a.references) expect(r.city).toBe('artigas')
})

test('referências fora dos dois polígonos vão para a cidade mais próxima; sem boundaries são descartadas', () => {
  const outsideBoth = ['n3799501035', 'n11432012837', 'n11432012838', 'w376971201']
  const a = buildDataset(ways, boundaries.artigas, 'artigas', { boundaries, references })
  const q = buildDataset(ways, boundaries.quarai, 'quarai', { boundaries, references })
  for (const id of outsideBoth) {
    expect(refIds(a)).toContain('artigas-ref-' + id)
    expect(refIds(q)).not.toContain('quarai-ref-' + id)
  }
  const plain = buildDataset(ways, boundaries.artigas, 'artigas', { references })
  for (const id of outsideBoth) expect(refIds(plain)).not.toContain('artigas-ref-' + id)
  expect(plain.references.length).toBe(a.references.length - outsideBoth.length)
})

test('referências: kind clinic e demais tipos aparecem, coordenadas com 5 casas', () => {
  const q = buildDataset(ways, boundaries.quarai, 'quarai', { boundaries, references })
  const a = buildDataset(ways, boundaries.artigas, 'artigas', { boundaries, references })
  expect(q.references.find((r) => r.kind === 'clinic')?.name).toBe('ESF PROFLURB')
  const kinds = new Set([...q.references, ...a.references].map((r) => r.kind))
  for (const k of ['fuel', 'school', 'church', 'hospital', 'clinic', 'pharmacy', 'supermarket', 'plaza', 'bridge']) {
    expect(kinds).toContain(k)
  }
  for (const r of [...q.references, ...a.references]) {
    expect(Math.round(r.at.lat * 1e5) / 1e5).toBe(r.at.lat)
    expect(Math.round(r.at.lng * 1e5) / 1e5).toBe(r.at.lng)
  }
})

test('a proveniência informada é gravada no dataset', () => {
  const source = {
    streets: { mirror: 'https://m.test/x', osmBaseTimestamp: '2026-11-09T00:00:00Z' },
    references: { mirror: 'https://m.test/x', osmBaseTimestamp: null },
  }
  expect(buildDataset(ways, boundaries.artigas, 'artigas', { source }).source).toEqual(source)
  expect(artigas().source).toBeUndefined()
})

test('nome compartilhado por ruas distintas (> 1 km) vira dois registros com nearHint diferentes', () => {
  const a = buildDataset(ways, boundaries.artigas, 'artigas', { boundaries, references })
  const ibi = a.streets.filter((s) => s.name === 'Ibirapitá')
  expect(ibi).toHaveLength(2)
  expect(ibi[0].id).not.toBe(ibi[1].id)
  expect(new Set(ibi.map((s) => s.id)).size).toBe(2)
  const hints = ibi.map((s) => s.nearHint)
  expect(hints.every((h) => typeof h === 'string' && h.length > 0)).toBe(true)
  expect(hints[0]).not.toBe(hints[1])
  // The hints are real reference names from this city.
  const names = new Set(a.references.map((r) => r.name))
  for (const h of hints) expect(names).toContain(h as string)
})

test('nearHint só existe em registros divididos; Ruta/Rodovia nunca são divididas', () => {
  const a = buildDataset(ways, boundaries.artigas, 'artigas', { boundaries, references })
  expect(byName(a.streets, '18 de Julio')?.nearHint).toBeUndefined()
  expect(a.streets.filter((s) => s.name === 'Ruta 30')).toHaveLength(1)
  // Every record with a hint belongs to a name that has more than one record.
  for (const s of a.streets.filter((x) => x.nearHint)) {
    expect(a.streets.filter((x) => x.name === s.name).length).toBeGreaterThan(1)
  }
})

test('partes a menos de 1 km continuam um único registro', () => {
  const base = ways.find((w) => w.tags?.name === 'Aparicio Saravia') as OverpassWay
  // A copy of a real way shifted ~300 m north under the same name: still one street.
  const shifted: OverpassWay = {
    ...base,
    id: 9_000_001,
    geometry: (base.geometry ?? []).map((g) => ({ lat: g.lat + 0.0027, lon: g.lon })),
  }
  const d = buildDataset([...ways, shifted], boundaries.artigas, 'artigas')
  expect(d.streets.filter((s) => s.name === 'Aparicio Saravia')).toHaveLength(1)
})
