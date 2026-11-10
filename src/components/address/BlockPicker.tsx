'use client'

// Camada 1 do endereço (spec 9.2): "entre quais esquinas?". As opções vêm de `intersections`, na ordem
// em que as esquinas aparecem ao longo da rua, e cada uma carrega a coordenada do MEIO do trecho: é ela
// que garante lat/lng quando não há GPS (o motor de preço não cota um endereço sem coordenada).
import type { Locale } from '@/lib/landing/content'
import { haversineMeters } from '@/lib/geo/distance'
import { round5 } from '@/lib/geo/geometry'
import type { LatLng, Street } from '@/lib/geo/types'

export type Block = {
  /** Estável para a mesma rua: chave das esquinas + comprimento. */
  id: string
  /** `between`: entre duas esquinas. `end`: da última esquina até a ponta da rua. */
  kind: 'between' | 'end'
  /** Nome(s) da esquina de onde o trecho parte; esquinas com dois nomes saem como "Rua X / Rua Y". */
  from: string
  /** Nome(s) da esquina em que o trecho termina; `null` nas pontas. */
  to: string | null
  /** Ponto sobre a rua, a meio caminho do traçado (não a média das esquinas, que numa curva cai fora). */
  midpoint: LatLng
  lengthM: number
}

/** Valor do seletor quando o cliente não sabe a quadra: grava precision 'rua'. */
export const UNKNOWN_BLOCK = 'rua'

/** Trecho mais curto que isto não é uma quadra: é pista dupla, rotatória ou esquina repetida. */
const MIN_BLOCK_M = 25
/** Entre duas esquinas com o mesmo nome, só vale a pena oferecer o trecho se for longo (uma curva). */
const MIN_SAME_NAME_BLOCK_M = 80
/** Um ponto de esquina que não coincide com vértice da rua é encaixado no vértice mais próximo até aqui. */
const SNAP_M = 10
/** Dois trechos entre as mesmas esquinas com pontos médios a menos disto são o mesmo trecho (pista dupla). */
const TWIN_M = 30

const COPY = {
  'pt-BR': {
    legend: 'Entre quais esquinas fica?',
    help: 'Escolha o trecho mais perto da sua casa. Isso põe o ponto no lugar certo da rua.',
    between: (a: string, b: string) => `Entre ${a} e ${b}`,
    end: (a: string) => `Depois de ${a} (fim da rua)`,
    unknown: 'Não sei entre quais ruas',
  },
  'es-UY': {
    legend: '¿Entre qué esquinas queda?',
    help: 'Elegí el tramo más cercano a tu casa. Así ubicamos el punto en el lugar correcto de la calle.',
    between: (a: string, b: string) => `Entre ${a} y ${b}`,
    end: (a: string) => `Después de ${a} (fin de la calle)`,
    unknown: 'No sé entre qué calles queda',
  },
} as const

/** O texto do trecho, no idioma do cliente; é também o que vai em `between_streets`. */
export function blockLabel(block: Block, locale: Locale): string {
  const c = COPY[locale]
  return block.kind === 'between' ? c.between(block.from, block.to ?? '') : c.end(block.from)
}

// ---------------------------------------------------------------------------------------------
// Geometria
// ---------------------------------------------------------------------------------------------
const key = (p: LatLng) => `${p.lat},${p.lng}`

type Node = { p: LatLng; adj: Map<string, number> }

/** Os segmentos do OSM chegam fora de ordem e em qualquer sentido; o que os liga são vértices idênticos. */
function buildGraph(street: Street): Map<string, Node> {
  const nodes = new Map<string, Node>()
  const node = (p: LatLng) => {
    const k = key(p)
    let n = nodes.get(k)
    if (!n) nodes.set(k, (n = { p, adj: new Map() }))
    return n
  }
  for (const seg of street.segments) {
    for (let i = 0; i < seg.length; i++) {
      const a = node(seg[i])
      if (i === 0) continue
      const prev = node(seg[i - 1])
      if (prev === a) continue
      const w = haversineMeters(prev.p, a.p)
      prev.adj.set(key(a.p), w)
      a.adj.set(key(prev.p), w)
    }
  }
  return nodes
}

/** Ponto a `dist` metros do início de uma polilinha. */
function pointAlong(pts: LatLng[], dist: number): LatLng {
  let left = dist
  for (let i = 1; i < pts.length; i++) {
    const w = haversineMeters(pts[i - 1], pts[i])
    if (left <= w || i === pts.length - 1) {
      const t = w === 0 ? 0 : Math.min(1, left / w)
      return {
        lat: round5(pts[i - 1].lat + (pts[i].lat - pts[i - 1].lat) * t),
        lng: round5(pts[i - 1].lng + (pts[i].lng - pts[i - 1].lng) * t),
      }
    }
    left -= w
  }
  return pts[0]
}

/** Metros por grau neste ponto (equiretangular, o bastante para distâncias de centenas de metros). */
function scale(lat: number) {
  return { mLat: 111_195, mLng: 111_195 * Math.cos((lat * Math.PI) / 180) }
}

function toSegmentDistance(p: LatLng, a: LatLng, b: LatLng): { dist: number; at: LatLng } {
  const { mLat, mLng } = scale(p.lat)
  const ax = (a.lng - p.lng) * mLng
  const ay = (a.lat - p.lat) * mLat
  const bx = (b.lng - p.lng) * mLng
  const by = (b.lat - p.lat) * mLat
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2))
  const x = ax + t * dx
  const y = ay + t * dy
  return { dist: Math.hypot(x, y), at: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t } }
}

/** Distância do ponto ao traçado da rua, em metros (`Infinity` se a rua não tem geometria). */
export function distanceToStreetMeters(street: Street, p: LatLng): number {
  let best = Infinity
  for (const seg of street.segments) {
    if (seg.length === 1) best = Math.min(best, haversineMeters(seg[0], p))
    for (let i = 1; i < seg.length; i++) best = Math.min(best, toSegmentDistance(p, seg[i - 1], seg[i]).dist)
  }
  return best
}

/**
 * Um ponto SOBRE a rua para quando o cliente não sabe a quadra (precision 'rua'): o centro do trecho
 * contínuo mais longo, encaixado na rua. Nunca um ponto no ar entre dois pedaços desconexos.
 */
export function streetAnchor(street: Street): LatLng {
  const nodes = buildGraph(street)
  // componentes conexos
  const comp = new Map<string, number>()
  let n = 0
  for (const start of nodes.keys()) {
    if (comp.has(start)) continue
    const stack = [start]
    comp.set(start, n)
    while (stack.length) {
      const cur = stack.pop()!
      for (const nb of nodes.get(cur)!.adj.keys()) {
        if (!comp.has(nb)) {
          comp.set(nb, n)
          stack.push(nb)
        }
      }
    }
    n++
  }
  if (n === 0) return street.segments[0]?.[0] ?? { lat: 0, lng: 0 }

  const edges: { a: LatLng; b: LatLng; w: number; c: number }[] = []
  const total = new Array<number>(n).fill(0)
  for (const [k, node] of nodes) {
    for (const [nk, w] of node.adj) {
      if (k < nk) {
        const c = comp.get(k)!
        edges.push({ a: node.p, b: nodes.get(nk)!.p, w, c })
        total[c] += w
      }
    }
  }
  let best = 0
  for (let c = 1; c < n; c++) if (total[c] > total[best]) best = c
  const mine = edges.filter((e) => e.c === best)
  if (mine.length === 0) return nodes.values().next().value!.p
  let w = 0
  let lat = 0
  let lng = 0
  for (const e of mine) {
    w += e.w
    lat += ((e.a.lat + e.b.lat) / 2) * e.w
    lng += ((e.a.lng + e.b.lng) / 2) * e.w
  }
  const centroid = { lat: lat / w, lng: lng / w }
  let nearest = { dist: Infinity, at: mine[0].a }
  for (const e of mine) {
    const d = toSegmentDistance(centroid, e.a, e.b)
    if (d.dist < nearest.dist) nearest = d
  }
  return { lat: round5(nearest.at.lat), lng: round5(nearest.at.lng) }
}

type Walk = { end: string; atCorner: boolean; path: LatLng[]; len: number }

/**
 * Os trechos da rua entre esquinas consecutivas (e da última esquina até a ponta). Ruas do OSM não são
 * linhas simples: vêm em vários segmentos e às vezes em mais de um pedaço, então o caminho é achado
 * andando pelo grafo da rua a partir de cada esquina até esbarrar em outra esquina ou na ponta.
 */
export function deriveBlocks(street: Street): Block[] {
  const nodes = buildGraph(street)
  if (nodes.size === 0) return []

  // esquinas: nome(s) por vértice
  const cornerNames = new Map<string, Set<string>>()
  for (const x of street.intersections) {
    let k = key(x.at)
    if (!nodes.has(k)) {
      // não coincide com vértice: encaixa no mais próximo, se estiver perto
      let near: { k: string; d: number } | null = null
      for (const [nk, node] of nodes) {
        const d = haversineMeters(node.p, x.at)
        if (d <= SNAP_M && (!near || d < near.d)) near = { k: nk, d }
      }
      if (!near) continue
      k = near.k
    }
    if (!cornerNames.has(k)) cornerNames.set(k, new Set())
    cornerNames.get(k)!.add(x.streetName)
  }
  const label = (k: string) => [...cornerNames.get(k)!].sort((a, b) => a.localeCompare(b)).join(' / ')

  // eixo principal da rua, para ordenar de modo estável (norte->sul ou oeste->leste) e orientar from/to
  let minLat = Infinity
  let maxLat = -Infinity
  let minLng = Infinity
  let maxLng = -Infinity
  for (const { p } of nodes.values()) {
    minLat = Math.min(minLat, p.lat)
    maxLat = Math.max(maxLat, p.lat)
    minLng = Math.min(minLng, p.lng)
    maxLng = Math.max(maxLng, p.lng)
  }
  const { mLat, mLng } = scale((minLat + maxLat) / 2)
  const alongNorthSouth = (maxLat - minLat) * mLat >= (maxLng - minLng) * mLng
  const axis = (p: LatLng) => (alongNorthSouth ? -p.lat : p.lng)

  const blocks = new Map<string, Block>()
  for (const start of cornerNames.keys()) {
    const found: Walk[] = []
    const go = (path: string[], len: number) => {
      if (found.length >= 64) return
      const cur = path[path.length - 1]
      if (cornerNames.has(cur)) {
        found.push({ end: cur, atCorner: true, path: path.map((k) => nodes.get(k)!.p), len })
        return
      }
      const next = [...nodes.get(cur)!.adj].filter(([k]) => !path.includes(k))
      if (next.length === 0) found.push({ end: cur, atCorner: false, path: path.map((k) => nodes.get(k)!.p), len })
      for (const [k, w] of next) go([...path, k], len + w)
    }
    for (const [first, w] of nodes.get(start)!.adj) go([start, first], w)

    for (const f of found) {
      if (f.len < MIN_BLOCK_M) continue
      const mid = pointAlong(f.path, f.len / 2)
      if (f.atCorner) {
        if (f.end === start) continue
        const [a, b] = axis(nodes.get(start)!.p) <= axis(nodes.get(f.end)!.p) ? [start, f.end] : [f.end, start]
        if (label(a) === label(b) && f.len < MIN_SAME_NAME_BLOCK_M) continue
        const id = `${a}|${b}#${Math.round(f.len)}`
        // rotatória e pista dupla dão dois caminhos quase iguais entre as mesmas esquinas: uma opção só
        const twin = [...blocks.values()].some(
          (x) => x.from === label(a) && x.to === label(b) && haversineMeters(x.midpoint, mid) < TWIN_M,
        )
        if (!blocks.has(id) && !twin) {
          blocks.set(id, { id, kind: 'between', from: label(a), to: label(b), midpoint: mid, lengthM: Math.round(f.len) })
        }
      } else {
        const id = `${start}|end:${f.end}`
        if (!blocks.has(id)) {
          blocks.set(id, { id, kind: 'end', from: label(start), to: null, midpoint: mid, lengthM: Math.round(f.len) })
        }
      }
    }
  }

  // ordem de leitura ao longo da rua; a ponta vem junto da esquina de onde parte
  return [...blocks.values()].sort(
    (x, y) => axis(x.midpoint) - axis(y.midpoint) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0),
  )
}

// ---------------------------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------------------------
type Props = {
  blocks: Block[]
  /** `Block.id`, `UNKNOWN_BLOCK` ou `null` (nada escolhido ainda). */
  value: string | null
  onChange: (value: string) => void
  locale: Locale
}

export function BlockPicker({ blocks, value, onChange, locale }: Props) {
  const c = COPY[locale]
  const rows = [
    ...blocks.map((b) => ({ id: b.id, text: blockLabel(b, locale) })),
    { id: UNKNOWN_BLOCK, text: c.unknown },
  ]
  return (
    <fieldset className="grid gap-2">
      <legend className="text-base font-semibold">{c.legend}</legend>
      <p className="text-sm text-white/70">{c.help}</p>
      <div className="grid gap-2">
        {rows.map((r) => (
          <label
            key={r.id}
            className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-white/20 px-3 py-2 has-[:checked]:border-sol has-[:checked]:bg-white/5"
          >
            <input
              type="radio"
              name="block"
              value={r.id}
              checked={value === r.id}
              onChange={() => onChange(r.id)}
              className="size-5 accent-[var(--color-sol)]"
            />
            <span className="text-base">{r.text}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
