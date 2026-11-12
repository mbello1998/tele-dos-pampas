import { haversineMeters } from './distance'
import type { LatLng } from './types'

/**
 * A ROTA PELAS RUAS, e as contas que se faz em cima dela.
 *
 * `osrm.ts` pede só a distância (`overview=false`) porque o PREÇO só precisa disso. O rastreio precisa da
 * linha: sem ela o marcador corta quarteirão, atravessa quadra e cruza o rio a nado — e quem está esperando
 * na calçada percebe na hora que aquilo não é o motoboy de verdade.
 *
 * Tudo aqui é função pura sobre a linha. Quem fala com a rede é `fetchRoute`; o resto só calcula.
 */

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving'
const TIMEOUT_MS = 6000
/** Linha reta -> malha de ruas, quando o OSRM não responde. O mesmo fator de `osrm.ts`. */
const URBAN_GRID_FACTOR = 1.35

export type Route = {
  /** Os vértices, do ponto de partida ao destino. Com pelo menos dois pontos. */
  line: LatLng[]
  /** Distância acumulada até cada vértice, em metros. Mesmo tamanho de `line`, começa em 0. */
  cumulative: number[]
  meters: number
  /** O que o roteador estima, em segundos. Serve de ponto de partida; o tempo real vem da medição. */
  seconds: number
  /** `osrm` = a rota real pelas ruas. `reta` = o OSRM não respondeu e isto é um segmento só. */
  source: 'osrm' | 'reta'
}

/** Distâncias acumuladas ao longo da linha. É o que transforma "um ponto da linha" em "quantos metros dali". */
export function cumulativeMeters(line: LatLng[]): number[] {
  const out = [0]
  for (let i = 1; i < line.length; i++) out.push(out[i - 1] + haversineMeters(line[i - 1], line[i]))
  return out
}

function toRoute(line: LatLng[], seconds: number, source: Route['source']): Route {
  const cumulative = cumulativeMeters(line)
  return { line, cumulative, meters: Math.round(cumulative[cumulative.length - 1]), seconds: Math.round(seconds), source }
}

/** A rota reta, para quando o roteador não responde: duas pontas e a distância corrigida pela malha. */
export function straightRoute(a: LatLng, b: LatLng): Route {
  const metros = haversineMeters(a, b) * URBAN_GRID_FACTOR
  // 22 km/h é o que uma moto faz numa cidade pequena, contando esquina e lombada.
  return toRoute([a, b], (metros / 1000 / 22) * 3600, 'reta')
}

function parseGeoJson(body: unknown): { line: LatLng[]; seconds: number } | null {
  if (typeof body !== 'object' || body === null) return null
  const { code, routes } = body as { code?: unknown; routes?: unknown }
  if (code !== 'Ok' || !Array.isArray(routes) || routes.length === 0) return null
  const first = routes[0] as { geometry?: { coordinates?: unknown }; duration?: unknown }
  const coords = first?.geometry?.coordinates
  if (!Array.isArray(coords) || coords.length < 2) return null
  const line: LatLng[] = []
  for (const c of coords) {
    // GeoJSON é [lng, lat], nesta ordem. Trocar isto põe o motoboy na China.
    if (!Array.isArray(c) || c.length < 2) return null
    const [lng, lat] = c as [unknown, unknown]
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
    line.push({ lat, lng })
  }
  const duration = typeof first.duration === 'number' && Number.isFinite(first.duration) ? first.duration : 0
  return { line, seconds: duration }
}

/**
 * A rota de verdade, pelas ruas. NUNCA levanta: qualquer falha vira a rota reta, porque uma tela de rastreio
 * sem linha nenhuma é pior do que uma linha aproximada — a pessoa precisa ver para onde o motoboy vai.
 */
export async function fetchRoute(a: LatLng, b: LatLng): Promise<Route> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const url = `${OSRM_BASE}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`
    const res = await fetch(url, { signal: controller.signal })
    if (res.status !== 200) return straightRoute(a, b)
    const parsed = parseGeoJson(await res.json())
    return parsed ? toRoute(parsed.line, parsed.seconds, 'osrm') : straightRoute(a, b)
  } catch {
    return straightRoute(a, b)
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------------------------
// Andar sobre a linha
// ---------------------------------------------------------------------------------------------

const R = 6_371_000
const rad = (d: number) => (d * Math.PI) / 180

/**
 * Projeção plana local. Em dois quarteirões a Terra é plana o bastante, e isto evita trigonometria esférica
 * dentro de um laço que roda a cada quadro.
 */
function toPlane(p: LatLng, origin: LatLng): { x: number; y: number } {
  return { x: rad(p.lng - origin.lng) * R * Math.cos(rad(origin.lat)), y: rad(p.lat - origin.lat) * R }
}

export type OnRoute = {
  /** Quantos metros da partida, medidos SOBRE a linha. */
  metersAlong: number
  /** O ponto correspondente, já em cima da rua. */
  snapped: LatLng
  /** A que distância o GPS caiu da linha. Grande = desviou da rota, ou o sinal está ruim. */
  offMeters: number
}

/**
 * ONDE, NA ROTA, ESTÁ ESTE PONTO. É o que gruda o motoboy na rua: o GPS cai na calçada, no quintal ou a 40 m
 * dali, e o marcador precisa aparecer sobre o asfalto do jeito que a pessoa esperaria ver.
 *
 * Varre todos os segmentos e fica com o mais próximo. Com rotas de cidade pequena (dezenas de vértices) isso
 * é barato e não erra; uma busca incremental a partir do último ponto seria mais rápida e volta atrás errado
 * quando o motoboy dá meia-volta.
 */
export function projectOnto(route: Route, point: LatLng): OnRoute {
  const { line, cumulative } = route
  const origin = line[0]
  const p = toPlane(point, origin)
  let melhor = { d2: Infinity, metersAlong: 0, snapped: line[0] }

  for (let i = 1; i < line.length; i++) {
    const a = toPlane(line[i - 1], origin)
    const b = toPlane(line[i], origin)
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    // t = onde cai a perpendicular, preso ao segmento: 0 é o começo, 1 é o fim.
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
    const qx = a.x + t * dx
    const qy = a.y + t * dy
    const d2 = (p.x - qx) ** 2 + (p.y - qy) ** 2
    if (d2 < melhor.d2) {
      const trecho = cumulative[i] - cumulative[i - 1]
      melhor = {
        d2,
        metersAlong: cumulative[i - 1] + trecho * t,
        snapped: {
          lat: line[i - 1].lat + (line[i].lat - line[i - 1].lat) * t,
          lng: line[i - 1].lng + (line[i].lng - line[i - 1].lng) * t,
        },
      }
    }
  }
  return { metersAlong: melhor.metersAlong, snapped: melhor.snapped, offMeters: Math.sqrt(melhor.d2) }
}

/** O ponto da rota a tantos metros da partida. Fora das pontas, devolve a ponta. */
export function pointAt(route: Route, metersAlong: number): LatLng {
  const { line, cumulative } = route
  const total = cumulative[cumulative.length - 1]
  if (metersAlong <= 0) return line[0]
  if (metersAlong >= total) return line[line.length - 1]
  let i = 1
  while (i < cumulative.length && cumulative[i] < metersAlong) i++
  const trecho = cumulative[i] - cumulative[i - 1]
  const t = trecho === 0 ? 0 : (metersAlong - cumulative[i - 1]) / trecho
  return {
    lat: line[i - 1].lat + (line[i].lat - line[i - 1].lat) * t,
    lng: line[i - 1].lng + (line[i].lng - line[i - 1].lng) * t,
  }
}

/** Quanto falta, pela rua — não em linha reta. */
export const remainingMeters = (route: Route, metersAlong: number): number =>
  Math.max(0, route.meters - metersAlong)

/** O trecho que ainda falta, para desenhar o caminho à frente em destaque. */
export function remainingLine(route: Route, metersAlong: number): LatLng[] {
  const { line, cumulative } = route
  const i = cumulative.findIndex((c) => c > metersAlong)
  if (i <= 0) return [...line]
  return [pointAt(route, metersAlong), ...line.slice(i)]
}
