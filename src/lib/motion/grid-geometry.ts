// Geometria da malha de ruas para o desenho da landing.
//
// Funções puras: recebem os datasets reais (public/data/*.json, o mesmo que alimenta a busca de
// endereço) e devolvem caminhos SVG prontos num quadro fixo, centrado na ponte. Quem usa:
//   - StreetGridDraw, no navegador, depois de buscar os datasets sob demanda;
//   - scripts/landing/build-poster.ts, que gera o poster estático do hero com a mesma conta.
// Assim o poster e o desenho animado nunca divergem.
import type { City, LatLng, Reference, StreetDataset } from '@/lib/geo/types'

export const GRID_VIEWBOX = 1000

/** Largura do quadro em metros: pega o miolo urbano das duas cidades e deixa a periferia de fora. */
const FRAME_METERS = 6400
const PX_PER_METER = GRID_VIEWBOX / FRAME_METERS
/** Tolerância de simplificação (Douglas-Peucker), em unidades do viewBox. */
const SIMPLIFY_EPSILON = 0.7
/** Vértices além desta folga fora do quadro são descartados. */
const CLIP_MARGIN = 40

export type Pt = { x: number; y: number }

export type Mesh = {
  /** Um único caminho por cidade, com as ruas ordenadas da ponte para fora. */
  paths: Record<City, string>
  /** Cabeceiras da ponte: `quarai` é a ponta do lado brasileiro, `artigas` a do uruguaio. */
  bridge: { quarai: Pt; artigas: Pt } | null
  /** Curso estilizado do rio. O dataset do OSM não tem hidrografia, então isto é ilustração. */
  river: string
  /** Total de vértices que entraram nos caminhos (para depuração e testes). */
  vertexCount: number
}

const round1 = (n: number) => Math.round(n * 10) / 10
const fmt = (p: Pt) => `${round1(p.x)} ${round1(p.y)}`

function bridgeReferences(datasets: StreetDataset[]): Reference[] {
  return datasets.flatMap((d) => d.references.filter((r) => r.kind === 'bridge'))
}

/** Centro do quadro: a média das referências "ponte". Sem ponte, o centro dos vértices. */
export function frameCenter(datasets: StreetDataset[]): LatLng {
  const bridges = bridgeReferences(datasets)
  const pts: LatLng[] =
    bridges.length > 0
      ? bridges.map((r) => r.at)
      : datasets.flatMap((d) => d.streets.flatMap((s) => s.segments.flat()))
  if (pts.length === 0) return { lat: 0, lng: 0 }
  const lat = pts.reduce((a, p) => a + p.lat, 0) / pts.length
  const lng = pts.reduce((a, p) => a + p.lng, 0) / pts.length
  return { lat, lng }
}

/** Projeção equiretangular local, em unidades do viewBox, com o centro no meio do quadro. */
export function makeProjector(center: LatLng): (p: LatLng) => Pt {
  const kx = Math.cos((center.lat * Math.PI) / 180) * 111_320
  const ky = 110_540
  const mid = GRID_VIEWBOX / 2
  return (p) => ({
    x: mid + (p.lng - center.lng) * kx * PX_PER_METER,
    y: mid - (p.lat - center.lat) * ky * PX_PER_METER,
  })
}

function perpendicularDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len
}

/** Douglas-Peucker. Mantém sempre as pontas, então cruzamentos entre ruas continuam coincidindo. */
export function simplify(points: Pt[], epsilon = SIMPLIFY_EPSILON): Pt[] {
  if (points.length <= 2) return points
  let worst = 0
  let index = 0
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], points[0], points[points.length - 1])
    if (d > worst) {
      worst = d
      index = i
    }
  }
  if (worst <= epsilon) return [points[0], points[points.length - 1]]
  const left = simplify(points.slice(0, index + 1), epsilon)
  const right = simplify(points.slice(index), epsilon)
  return [...left.slice(0, -1), ...right]
}

const inFrame = (p: Pt) => p.x >= -CLIP_MARGIN && p.x <= GRID_VIEWBOX + CLIP_MARGIN && p.y >= -CLIP_MARGIN && p.y <= GRID_VIEWBOX + CLIP_MARGIN

/** Quebra uma polilinha em trechos contínuos que ficam dentro do quadro. */
function clipRuns(points: Pt[]): Pt[][] {
  const runs: Pt[][] = []
  let run: Pt[] = []
  for (const p of points) {
    if (inFrame(p)) run.push(p)
    else {
      if (run.length > 1) runs.push(run)
      run = []
    }
  }
  if (run.length > 1) runs.push(run)
  return runs
}

function nearestDistance(points: Pt[], to: Pt): number {
  let best = Infinity
  for (const p of points) best = Math.min(best, Math.hypot(p.x - to.x, p.y - to.y))
  return best
}

/** `M x y x y x y` — pares seguintes ao M são lineto implícito, o que encurta a string. */
function toPathData(runs: Pt[][]): string {
  return runs.map((run) => `M${run.map(fmt).join(' ')}`).join('')
}

function buildRiver(bridge: { quarai: Pt; artigas: Pt }): string {
  const mid = { x: (bridge.quarai.x + bridge.artigas.x) / 2, y: (bridge.quarai.y + bridge.artigas.y) / 2 }
  const ax = bridge.artigas.x - bridge.quarai.x
  const ay = bridge.artigas.y - bridge.quarai.y
  const len = Math.hypot(ax, ay) || 1
  const along = { x: ax / len, y: ay / len }
  // O rio corre perpendicular à ponte.
  const across = { x: -along.y, y: along.x }
  const reach = 720
  const sway = 150
  const a = { x: mid.x - across.x * reach + along.x * sway, y: mid.y - across.y * reach + along.y * sway }
  const b = { x: mid.x + across.x * reach - along.x * sway, y: mid.y + across.y * reach - along.y * sway }
  const c = { x: (a.x + mid.x) / 2 - along.x * sway, y: (a.y + mid.y) / 2 - along.y * sway }
  return `M${fmt(a)}Q${fmt(c)} ${fmt(mid)}T${fmt(b)}`
}

export function buildMesh(datasets: StreetDataset[]): Mesh {
  const center = frameCenter(datasets)
  const project = makeProjector(center)
  const origin: Pt = { x: GRID_VIEWBOX / 2, y: GRID_VIEWBOX / 2 }
  const paths: Record<City, string> = { quarai: '', artigas: '' }
  let vertexCount = 0

  for (const dataset of datasets) {
    const streets = dataset.streets
      .map((street) => {
        const runs = street.segments.flatMap((segment) => clipRuns(simplify(segment.map(project))))
        return { runs, distance: nearestDistance(runs.flat(), origin) }
      })
      .filter((s) => s.runs.length > 0)
      .sort((a, b) => a.distance - b.distance)
    const runs = streets.flatMap((s) => s.runs)
    vertexCount += runs.reduce((n, r) => n + r.length, 0)
    paths[dataset.city] += toPathData(runs)
  }

  const bridges = bridgeReferences(datasets).map((r) => project(r.at))
  let bridge: Mesh['bridge'] = null
  if (bridges.length >= 2) {
    // O lado brasileiro fica ao norte (y menor); as pontas são os dois pontos mais distantes.
    const sorted = [...bridges].sort((a, b) => a.y - b.y)
    bridge = { quarai: sorted[0], artigas: sorted[sorted.length - 1] }
  }
  return { paths, bridge, river: bridge ? buildRiver(bridge) : '', vertexCount }
}
