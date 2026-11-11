'use client'

// Mapa do rastreio. Tiles de um provedor configurável + um marcador que desliza.
//
// POR QUE NÃO LEAFLET AQUI (decisão deliberada; não "conserte" trocando por Leaflet para ficar consistente).
// O projeto usa Leaflet no seletor de endereço (src/components/map), e ali ele é a ferramenta certa: o usuário
// arrasta, dá pan e zoom para colocar um pino, então paga o peso de arrasto, pinça, inércia e camadas. Aqui o
// cliente só ASSISTE a uma moto andar. Quadro fixo que segue o motoboy, sem gesto nenhum: Leaflet custaria
// dezenas de kB de JS num Android de entrada com plano pré-pago (a restrição que não se negocia) e trocaria o
// movimento do marcador pelo laço interno dele. Aqui marcador e câmera andam por `transform`, num único laço de
// requestAnimationFrame (createMarkerAnimator). A divisão é de propósito: Leaflet onde o usuário manipula o
// mapa, uma vista levíssima onde ele só olha.
//
// Tudo degrada sem quebrar:
//   - setting `map.tile_url` ausente, economia de dados ou tiles que não carregam: no lugar do mapa fica o
//     endereço em texto (e a distância, se houver), e a timeline continua na página;
//   - sem posição do motoboy a página nem monta este componente (ver TrackingView);
//   - prefers-reduced-motion: o marcador vai direto ao ponto novo, sem deslizar.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { haversineMeters } from '@/lib/geo/distance'
import type { LatLng } from '@/lib/geo/types'
import { isConstrainedNetwork, prefersReducedMotion } from '@/lib/motion/gsap'
import { bearingDegrees, createMarkerAnimator, glideDurationMs } from '@/lib/realtime/position'

const TILE = 256
const MIN_ZOOM = 13
const MAX_ZOOM = 17
/** Sem nenhum tile carregado depois disto, o mapa é dado como indisponível. */
const TILES_TIMEOUT_MS = 8_000

// ---------------------------------------------------------------------------------------------
// Matemática de mapa (Web Mercator, tiles de 256 px). Funções puras.
// ---------------------------------------------------------------------------------------------
/** Preenche o modelo do provedor. {s} vira "a"; {r} (retina) some: tiles @2x custam o dobro de dados. */
export function tileUrl(template: string, z: number, x: number, y: number): string {
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)).replace('{s}', 'a').replace('{r}', '')
}

/** Posição no "mundo" de pixels do zoom `z` (origem no canto noroeste do mundo). */
export function toWorldPx(p: LatLng, z: number): { x: number; y: number } {
  const scale = TILE * 2 ** z
  const lat = Math.max(-85.0511, Math.min(85.0511, p.lat))
  const sin = Math.sin((lat * Math.PI) / 180)
  return { x: ((p.lng + 180) / 360) * scale, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale }
}

type Size = { width: number; height: number }

/** Maior zoom (entre 13 e 17) em que todos os pontos cabem na tela com folga. Um ponto só: o zoom máximo. */
export function fitZoom(points: LatLng[], size: Size, padding = 56): number {
  if (points.length < 2) return MAX_ZOOM
  for (let z = MAX_ZOOM; z > MIN_ZOOM; z--) {
    const px = points.map((p) => toWorldPx(p, z))
    const w = Math.max(...px.map((p) => p.x)) - Math.min(...px.map((p) => p.x))
    const h = Math.max(...px.map((p) => p.y)) - Math.min(...px.map((p) => p.y))
    if (w <= size.width - padding * 2 && h <= size.height - padding * 2) return z
  }
  return MIN_ZOOM
}

type TileRange = { x0: number; x1: number; y0: number; y1: number }
function tileRange(center: { x: number; y: number }, size: Size, z: number): TileRange {
  const max = 2 ** z - 1
  const clamp = (n: number) => Math.max(0, Math.min(max, n))
  return {
    x0: clamp(Math.floor((center.x - size.width / 2) / TILE)),
    x1: clamp(Math.floor((center.x + size.width / 2) / TILE)),
    y0: clamp(Math.floor((center.y - size.height / 2) / TILE)),
    y1: clamp(Math.floor((center.y + size.height / 2) / TILE)),
  }
}
const rangeKey = (r: TileRange) => `${r.x0}.${r.x1}.${r.y0}.${r.y1}`

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.max(10, Math.round(meters / 10) * 10)} m`
  return `${(meters / 1000).toFixed(1).replace('.', ',')} km`
}

// ---------------------------------------------------------------------------------------------
// Componente
// ---------------------------------------------------------------------------------------------
export type MapLabels = {
  /** "Mapa indisponível" */
  unavailable: string
  /** "Motoboy" (nome acessível do marcador) */
  courier: string
  /** "a {m} do destino": {m} recebe a distância formatada */
  distance: string
  /** "Mostrar mapa" (botão no modo economia de dados) */
  showMap: string
  /** nome acessível do destino ("Seu endereço") */
  destination?: string
}

export type CourierFix = LatLng & { heading?: number | null; recordedAt?: number }

type Props = {
  /** Modelo do provedor, vindo de settings['map.tile_url']. Nulo: sem mapa, só texto. */
  tileUrlTemplate: string | null
  /** Crédito do provedor (settings['map.tile_attribution']); o OSM exige. */
  attribution?: string | null
  courier: CourierFix | null
  destination?: LatLng | null
  /** O endereço em texto: é o que aparece quando o mapa não pode. */
  addressText: string
  labels: MapLabels
}

export function CourierMap({ tileUrlTemplate, attribution, courier, destination, addressText, labels }: Props) {
  const [optedIn, setOptedIn] = useState(false)
  const [saveData, setSaveData] = useState(false)
  useEffect(() => setSaveData(isConstrainedNetwork()), [])

  const distanceText =
    courier && destination ? labels.distance.replace('{m}', formatDistance(haversineMeters(courier, destination))) : null

  if (!tileUrlTemplate) {
    return <MapFallback reason={labels.unavailable} addressText={addressText} distanceText={distanceText} />
  }
  if (saveData && !optedIn) {
    return (
      <MapFallback
        reason={null}
        addressText={addressText}
        distanceText={distanceText}
        action={
          <button type="button" onClick={() => setOptedIn(true)} className="mt-3 min-h-11 rounded-md border border-borda px-4 text-sm font-semibold text-white">
            {labels.showMap}
          </button>
        }
      />
    )
  }
  return (
    <TileMap
      template={tileUrlTemplate}
      attribution={attribution ?? null}
      courier={courier}
      destination={destination ?? null}
      addressText={addressText}
      distanceText={distanceText}
      labels={labels}
    />
  )
}

function MapFallback({
  reason,
  addressText,
  distanceText,
  action,
}: {
  reason: string | null
  addressText: string
  distanceText: string | null
  action?: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-borda bg-superficie p-4" data-map-fallback>
      {reason && <p className="text-sm font-semibold text-white/80">{reason}</p>}
      <p className="mt-1 text-base text-white">{addressText}</p>
      {distanceText && <p className="preco mt-1 text-sm text-sol">{distanceText}</p>}
      {action}
    </div>
  )
}

function TileMap({
  template,
  attribution,
  courier,
  destination,
  addressText,
  distanceText,
  labels,
}: {
  template: string
  attribution: string | null
  courier: CourierFix | null
  destination: LatLng | null
  addressText: string
  distanceText: string | null
  labels: MapLabels
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<HTMLDivElement>(null)
  const markerRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLDivElement>(null)

  const [size, setSize] = useState<Size>({ width: 360, height: 270 })
  const [zoom, setZoom] = useState(MAX_ZOOM)
  const [range, setRange] = useState<TileRange | null>(null)
  const [stats, setStats] = useState({ loaded: 0, errors: 0 })
  const [timedOut, setTimedOut] = useState(false)

  const zoomRef = useRef(zoom)
  const sizeRef = useRef(size)
  const destRef = useRef(destination)
  const rangeKeyRef = useRef('')
  const lastFixRef = useRef<{ pos: LatLng; at?: number } | null>(null)
  const animatorRef = useRef<ReturnType<typeof createMarkerAnimator> | null>(null)
  zoomRef.current = zoom
  sizeRef.current = size
  destRef.current = destination

  // Aplica a posição (do quadro atual do animador) como transform: marcador e câmera. Sem layout.
  const place = (pos: LatLng | null) => {
    const scene = sceneRef.current
    const marker = markerRef.current
    if (!pos || !scene || !marker) return
    const z = zoomRef.current
    const { width, height } = sizeRef.current
    const m = toWorldPx(pos, z)
    const d = destRef.current ? toWorldPx(destRef.current, z) : null
    const cam = d ? { x: (m.x + d.x) / 2, y: (m.y + d.y) / 2 } : m
    marker.style.transform = `translate3d(${m.x - 18}px, ${m.y - 18}px, 0)`
    scene.style.transform = `translate3d(${width / 2 - cam.x}px, ${height / 2 - cam.y}px, 0)`
    const next = tileRange(cam, sizeRef.current, z)
    const key = `${z}:${rangeKey(next)}`
    if (key !== rangeKeyRef.current) {
      rangeKeyRef.current = key
      setRange(next)
    }
  }
  const placeRef = useRef(place)
  placeRef.current = place

  // Tamanho real do quadro.
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setSize({ width: r.width, height: r.height })
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // O animador vive o tempo do componente.
  useEffect(() => {
    const animator = createMarkerAnimator({ onFrame: (p) => placeRef.current(p) })
    animatorRef.current = animator
    return () => {
      animator.stop()
      animatorRef.current = null
    }
  }, [])

  // Cada fix novo: zoom que encaixa motoboy e destino, rumo, e o deslize até o ponto.
  useEffect(() => {
    const animator = animatorRef.current
    if (!courier || !animator) return
    const pos: LatLng = { lat: courier.lat, lng: courier.lng }
    const prev = lastFixRef.current
    const nextZoom = fitZoom(destination ? [pos, destination] : [pos], size)
    if (nextZoom !== zoomRef.current) {
      zoomRef.current = nextZoom
      setZoom(nextZoom)
    }
    // Rumo: o do GPS quando há; senão, o do deslocamento (só se andou o bastante para o rumo valer).
    const heading =
      courier.heading != null ? courier.heading : prev && haversineMeters(prev.pos, pos) > 5 ? bearingDegrees(prev.pos, pos) : null
    if (heading != null && headingRef.current) headingRef.current.style.transform = `rotate(${heading}deg)`
    const duration = prefersReducedMotion() ? 0 : glideDurationMs(prev?.at, courier.recordedAt ?? Date.now())
    animator.moveTo(pos, duration)
    lastFixRef.current = { pos, at: courier.recordedAt ?? Date.now() }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reage ao fix; `size` e `destination` só entram no próximo
  }, [courier?.lat, courier?.lng, courier?.recordedAt])

  // Zoom ou quadro mudou: reposiciona sem animar.
  useEffect(() => {
    const cur = animatorRef.current?.current()
    if (cur) placeRef.current(cur)
  }, [zoom, size, destination?.lat, destination?.lng])

  // Mapa sem nenhum tile depois de um tempo: é dado como indisponível.
  useEffect(() => {
    const id = setTimeout(() => setTimedOut(true), TILES_TIMEOUT_MS)
    return () => clearTimeout(id)
  }, [])

  const failed = stats.loaded === 0 && (stats.errors >= 3 || timedOut)
  if (failed) return <MapFallback reason={labels.unavailable} addressText={addressText} distanceText={distanceText} />

  const tiles: { x: number; y: number }[] = []
  if (range) for (let x = range.x0; x <= range.x1; x++) for (let y = range.y0; y <= range.y1; y++) tiles.push({ x, y })
  const dest = destination ? toWorldPx(destination, zoom) : null

  return (
    <figure className="m-0" data-courier-map>
      <div ref={viewportRef} className="relative aspect-[4/3] w-full overflow-hidden rounded-lg bg-[#161c19]" style={{ touchAction: 'pan-y' }}>
        <div ref={sceneRef} className="absolute left-0 top-0 h-0 w-0 will-change-transform">
          {tiles.map(({ x, y }) => (
            // eslint-disable-next-line @next/next/no-img-element -- tiles de provedor externo, tamanho fixo
            <img
              key={`${zoom}/${x}/${y}`}
              src={tileUrl(template, zoom, x, y)}
              alt=""
              width={TILE}
              height={TILE}
              decoding="async"
              draggable={false}
              onLoad={() => setStats((s) => ({ ...s, loaded: s.loaded + 1 }))}
              onError={() => setStats((s) => ({ ...s, errors: s.errors + 1 }))}
              className="absolute left-0 top-0 max-w-none select-none"
              style={{ transform: `translate(${x * TILE}px, ${y * TILE}px)` }}
            />
          ))}
          {dest && (
            <div
              role="img"
              aria-label={labels.destination ?? addressText}
              className="absolute left-0 top-0"
              style={{ transform: `translate(${dest.x - 10}px, ${dest.y - 26}px)` }}
              data-destination-pin
            >
              <svg width="20" height="28" viewBox="0 0 20 28" aria-hidden="true">
                <path d="M10 0C4.5 0 0 4.4 0 9.8 0 17 10 28 10 28s10-11 10-18.2C20 4.4 15.5 0 10 0z" fill="#D9452B" />
                <circle cx="10" cy="9.8" r="3.6" fill="#fff" />
              </svg>
            </div>
          )}
          <div ref={markerRef} role="img" aria-label={labels.courier} className="absolute left-0 top-0 h-9 w-9 will-change-transform" data-courier-marker>
            <div ref={headingRef} className="h-9 w-9">
              <svg viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
                <circle cx="18" cy="18" r="16" fill="#F2A516" stroke="#0B0F0D" strokeWidth="2.5" />
                <path d="M18 7l7 15-7-3.4L11 22z" fill="#0B0F0D" />
              </svg>
            </div>
          </div>
        </div>
        {attribution && (
          <figcaption className="pointer-events-none absolute bottom-0 right-0 bg-black/55 px-1.5 py-0.5 text-[10px] text-white/80">{attribution}</figcaption>
        )}
      </div>
      <p className="mt-2 text-base text-white">{addressText}</p>
      {distanceText && <p className="preco text-sm text-sol">{distanceText}</p>}
    </figure>
  )
}
