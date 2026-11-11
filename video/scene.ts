// Geometria e relógio do loop. Funções puras: recebem a malha de verdade (public/data/grid-simplified.json) e
// devolvem polilinhas já projetadas na tela, mais o tempo de cada rua. Nada aqui lê arquivo nem sorteia nada,
// então o mesmo dado dá sempre o mesmo vídeo.
//
// A malha vem em coordenadas do mapa (viewBox 1000, Quaraí ao norte, Artigas ao sul, ponte na diagonal). Para a
// cena ela é GIRADA até a ponte ficar horizontal, com Quaraí à esquerda e Artigas à direita — o mesmo enquadramento
// da arte pintada (public/arte/pampa-fundo-*.webp): duas tramas, o rio no meio, a ponte atravessando. A rotação é
// a única licença; as ruas e as distâncias entre elas são as do dado.

export type Pt = { x: number; y: number }
export type Mesh = {
  paths: { quarai: string; artigas: string }
  bridge: { quarai: Pt; artigas: Pt }
  river: string
}
export type Palette = { noite: string; sol: string; brasa: string; rio: string; campo: string }
export type FormatName = 'retrato' | 'paisagem'

export type Layout = {
  width: number
  height: number
  /** y da linha do horizonte. */
  horizon: number
  sunX: number
  sunR: number
  /** Onde a malha começa (longe) e termina (perto) na tela, em y. */
  meshTop: number
  meshBottom: number
  /** Pixels por unidade do mapa, na borda de longe e na de perto. */
  scaleFar: number
  scaleNear: number
  /** Faixa do mapa (eixo "profundidade" depois da rotação) que entra na cena. */
  vMin: number
  vMax: number
  centerX: number
}

export const LAYOUTS: Record<FormatName, Layout> = {
  retrato: {
    width: 1080,
    height: 1920,
    horizon: 767,
    sunX: 540,
    sunR: 104,
    meshTop: 800,
    meshBottom: 1640,
    scaleFar: 0.5,
    scaleNear: 1.25,
    vMin: -430,
    vMax: 330,
    centerX: 540,
  },
  paisagem: {
    width: 1920,
    height: 1080,
    horizon: 430,
    sunX: 960,
    sunR: 118,
    meshTop: 452,
    meshBottom: 1040,
    scaleFar: 0.8,
    scaleNear: 2.1,
    vMin: -430,
    vMax: 330,
    centerX: 960,
  },
}

/* ---------- linha do tempo (em segundos) ---------- */
export const LOOP_SECONDS = 9
export const FPS = 20
export const LOOP_FRAMES = LOOP_SECONDS * FPS

export const T = {
  quarai: [0.35, 3.3] as const,
  artigas: [1.9, 4.9] as const,
  bridge: [4.4, 5.5] as const,
  trail: [5.2, 7.7] as const,
  /** Tudo o que foi aceso apaga junto, de volta ao estado do quadro 0. */
  fade: [7.9, 8.9] as const,
}

export const smooth = (x: number) => {
  const c = Math.min(1, Math.max(0, x))
  return c * c * (3 - 2 * c)
}
export const easeOut = (x: number) => {
  const c = Math.min(1, Math.max(0, x))
  return 1 - Math.pow(1 - c, 3)
}
export const range = (t: number, [a, b]: readonly [number, number]) => (t - a) / (b - a)

/* ---------- leitura da malha ---------- */
export function parseRuns(d: string): Pt[][] {
  return d
    .split('M')
    .filter(Boolean)
    .map((chunk) => {
      const n = chunk.trim().split(/\s+/).map(Number)
      const run: Pt[] = []
      for (let i = 0; i + 1 < n.length; i += 2) run.push({ x: n[i], y: n[i + 1] })
      return run
    })
    .filter((r) => r.length > 1)
}

const key = (p: Pt) => `${p.x},${p.y}`
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

type Graph = Map<string, { p: Pt; edges: { to: string; w: number }[] }>

function buildGraph(runs: Pt[][]): Graph {
  const g: Graph = new Map()
  const node = (p: Pt) => {
    const k = key(p)
    let n = g.get(k)
    if (!n) g.set(k, (n = { p, edges: [] }))
    return n
  }
  for (const run of runs) {
    for (let i = 0; i + 1 < run.length; i++) {
      const a = node(run[i])
      const b = node(run[i + 1])
      const w = dist(run[i], run[i + 1])
      a.edges.push({ to: key(run[i + 1]), w })
      b.edges.push({ to: key(run[i]), w })
    }
  }
  return g
}

/** Dijkstra simples (o grafo tem ~2 mil nós, não precisa de heap). */
function shortest(g: Graph, from: string): { d: Map<string, number>; prev: Map<string, string> } {
  const d = new Map<string, number>([[from, 0]])
  const prev = new Map<string, string>()
  const open = new Set<string>([from])
  while (open.size) {
    let best = ''
    let bd = Infinity
    for (const k of open) {
      const v = d.get(k)!
      if (v < bd) {
        bd = v
        best = k
      }
    }
    open.delete(best)
    for (const e of g.get(best)!.edges) {
      const nd = bd + e.w
      if (nd < (d.get(e.to) ?? Infinity)) {
        d.set(e.to, nd)
        prev.set(e.to, best)
        open.add(e.to)
      }
    }
  }
  return { d, prev }
}

function nearestNode(g: Graph, to: Pt): string {
  let best = ''
  let bd = Infinity
  for (const [k, n] of g) {
    const v = dist(n.p, to)
    if (v < bd) {
      bd = v
      best = k
    }
  }
  return best
}

/**
 * A rota do rastro, nas ruas de verdade: de um ponto afastado de Quaraí até a cabeceira da ponte, a ponte, e da
 * outra cabeceira até um ponto de Artigas. Cada metade é o caminho MAIS CURTO pelo grafo de ruas da cidade; o
 * ponto de partida é o mais distante (pelas ruas) dentre os que cabem a `reach` unidades da ponte. Determinístico.
 */
export function buildRoute(mesh: Mesh, reach: { quarai: number; artigas: number }): Pt[] {
  const half = (city: 'quarai' | 'artigas', head: Pt, maxEuclid: number): Pt[] => {
    const g = buildGraph(parseRuns(mesh.paths[city]))
    const root = nearestNode(g, head)
    const { d, prev } = shortest(g, root)
    let far = root
    let fd = -1
    for (const [k, v] of d) {
      if (dist(g.get(k)!.p, head) <= maxEuclid && v > fd) {
        fd = v
        far = k
      }
    }
    const chain: Pt[] = []
    for (let k: string | undefined = far; k !== undefined; k = prev.get(k)) chain.push(g.get(k)!.p)
    return chain // da ponta distante até a cabeceira
  }
  const q = half('quarai', mesh.bridge.quarai, reach.quarai)
  const a = half('artigas', mesh.bridge.artigas, reach.artigas).reverse() // da cabeceira até a ponta distante
  return [...q, mesh.bridge.quarai, mesh.bridge.artigas, ...a]
}

/* ---------- projeção ---------- */
export type Projector = {
  point: (p: Pt) => Pt
  /** Escala de largura (px por unidade) na profundidade desse ponto. */
  scaleAt: (p: Pt) => number
  /** Profundidade normalizada do ponto (0 = longe, 1 = perto), sem corte. */
  depth: (p: Pt) => number
}

export function makeProjector(mesh: Mesh, L: Layout): Projector {
  const mid = { x: (mesh.bridge.quarai.x + mesh.bridge.artigas.x) / 2, y: (mesh.bridge.quarai.y + mesh.bridge.artigas.y) / 2 }
  const rot = -Math.atan2(mesh.bridge.artigas.y - mesh.bridge.quarai.y, mesh.bridge.artigas.x - mesh.bridge.quarai.x)
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  const local = (p: Pt) => {
    const dx = p.x - mid.x
    const dy = p.y - mid.y
    return { u: c * dx - s * dy, v: s * dx + c * dy }
  }
  const span = L.vMax - L.vMin
  const scale = (t: number) => Math.max(L.scaleFar * 0.2, L.scaleFar + (L.scaleNear - L.scaleFar) * t)
  // y acompanha a integral da escala: onde a trama "encolhe", as ruas também se aproximam, como numa vista oblíqua.
  const integral = (t: number) => L.scaleFar * t + ((L.scaleNear - L.scaleFar) * t * t) / 2
  const total = integral(1)
  const depth = (p: Pt) => (local(p).v - L.vMin) / span
  return {
    depth,
    scaleAt: (p) => scale(depth(p)),
    point: (p) => {
      const { u, v } = local(p)
      const t = (v - L.vMin) / span
      return { x: L.centerX + u * scale(t), y: L.meshTop + ((L.meshBottom - L.meshTop) * integral(t)) / total }
    },
  }
}

export type DrawRun = {
  /** `M x y L x y …` pronto para o atributo `d`. */
  d: string
  length: number
  /** Quando a rua começa a se desenhar e quanto dura, em fração (0..1) da janela da cidade. */
  start: number
  grow: number
  /** Escala de largura na profundidade da rua (ruas de longe são mais finas). */
  width: number
}

const fmt = (n: number) => Math.round(n * 10) / 10
export const toD = (pts: Pt[]) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)} ${fmt(p.y)}`).join('')
export const polyLength = (pts: Pt[]) => pts.reduce((n, p, i) => (i === 0 ? 0 : n + dist(p, pts[i - 1])), 0)

/** Ruas de uma cidade, projetadas, cortadas ao quadro, na ordem em que o dado as entrega (da ponte para fora). */
export function cityRuns(d: string, proj: Projector, L: Layout): DrawRun[] {
  const raw = parseRuns(d)
  const inside = (p: Pt) => p.x > -30 && p.x < L.width + 30 && p.y >= L.meshTop - 4 && p.y <= L.height
  const keep: { pts: Pt[]; w: number }[] = []
  for (const run of raw) {
    let cur: Pt[] = []
    for (const p of run) {
      const t = proj.depth(p)
      const q = proj.point(p)
      if (t >= -0.02 && t <= 1.02 && inside(q)) cur.push(q)
      else {
        if (cur.length > 1) keep.push({ pts: cur, w: proj.scaleAt(p) })
        cur = []
      }
    }
    if (cur.length > 1) keep.push({ pts: cur, w: proj.scaleAt(run[0]) })
  }
  const n = keep.length
  return keep.map((k, i) => ({
    d: toD(k.pts),
    length: polyLength(k.pts),
    start: Math.pow(i / n, 0.85) * 0.78,
    grow: 0.22,
    width: k.w,
  }))
}

/** Ponto a `distance` px do começo da polilinha. */
export function pointAlong(pts: Pt[], distance: number): Pt {
  let left = distance
  for (let i = 1; i < pts.length; i++) {
    const seg = dist(pts[i], pts[i - 1])
    if (left <= seg) {
      const f = seg === 0 ? 0 : left / seg
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f }
    }
    left -= seg
  }
  return pts[pts.length - 1]
}

/** O curso estilizado do rio (Q/T do dado) amostrado em pontos. */
export function riverPoints(river: string, steps = 90): Pt[] {
  const n = river.match(/-?\d+(\.\d+)?/g)!.map(Number)
  // M a Q c m T b  (T reflete o ponto de controle anterior)
  const a = { x: n[0], y: n[1] }
  const c = { x: n[2], y: n[3] }
  const m = { x: n[4], y: n[5] }
  const b = { x: n[6], y: n[7] }
  const c2 = { x: 2 * m.x - c.x, y: 2 * m.y - c.y }
  const quad = (p0: Pt, p1: Pt, p2: Pt, t: number): Pt => ({
    x: (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * p1.x + t * t * p2.x,
    y: (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * p1.y + t * t * p2.y,
  })
  const pts: Pt[] = []
  for (let i = 0; i <= steps; i++) pts.push(quad(a, c, m, i / steps))
  for (let i = 1; i <= steps; i++) pts.push(quad(m, c2, b, i / steps))
  return pts
}
