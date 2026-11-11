'use client'

// Camada 2 do endereço: o pino. Dois caminhos, ambos opcionais: "usar minha localização" (Geolocation) e
// "marcar no mapa" (Leaflet, arrastável, já posicionado na quadra escolhida). Os dois gravam precision
// 'gps'. Nenhum bloqueia o formulário: sem permissão, sem rede ou sem tiles, o cliente segue com a quadra
// e a referência.
//
// O Leaflet só entra quando o cliente pede o mapa (next/dynamic, ssr: false => chunk próprio), e a URL
// dos tiles vem de settings['map.tile_url'], trocável sem mexer no código (spec 9.3).
import dynamic from 'next/dynamic'
import { useId, useRef, useState } from 'react'
import type { Locale } from '@/lib/landing/content'
import { distanceToStreetMeters } from './BlockPicker'
import type { LatLng, Street } from '@/lib/geo/types'

const LeafletMap = dynamic(() => import('@/components/map/LeafletMap'), {
  ssr: false,
  loading: () => <div className="h-72 animate-pulse rounded-lg bg-superficie" aria-hidden />,
})

/** Uma posição marcada pelo cliente. O formulário grava precision 'gps' sempre que existe uma. */
export type PinFix = LatLng & { source: 'gps' | 'pin' }

/** Além disto, a posição não é desta rua: quem pediu de longe, ou o pino foi parar em outro bairro. */
export const FAR_FROM_STREET_M = 500
/** Fix de GPS pior que isto (Wi-Fi/IP de computador) não vale como "gps": o entregador iria ao lugar errado. */
export const MAX_ACCURACY_M = 150

export type TileUrlLoader = () => Promise<string | null>

let tileUrlCache: Promise<string | null> | null = null

/**
 * Lê settings['map.tile_url'] (linha pública) direto do PostgREST, com a chave publicável. Aceita só um
 * modelo https com {z}/{x}/{y}: qualquer outra coisa vira "mapa indisponível", nunca uma URL estranha
 * dentro de <img>.
 */
export const fetchTileUrl: TileUrlLoader = () => {
  tileUrlCache ??= (async () => {
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    if (!base || !key) return null
    const res = await fetch(`${base}/rest/v1/settings?select=value&key=eq.map.tile_url&is_public=eq.true`, {
      headers: { apikey: key },
    })
    if (!res.ok) return null
    const rows = (await res.json()) as { value: unknown }[]
    const v = rows[0]?.value
    return typeof v === 'string' && /^https:\/\/\S*\{z\}\S*\{x\}\S*\{y\}\S*$/.test(v) ? v : null
  })().catch(() => {
    tileUrlCache = null // falha de rede não fica gravada: abrir o mapa de novo tenta outra vez
    return null
  })
  return tileUrlCache
}

const COPY = {
  'pt-BR': {
    title: 'Ponto exato (opcional)',
    help: 'A quadra já basta. Se quiser, marque o ponto exato da sua casa.',
    titleRequired: 'Ponto da sua casa (obrigatório)',
    helpRequired: 'Como a rua não está na lista, precisamos do ponto: use sua localização ou marque a casa no mapa.',
    gps: 'Usar minha localização',
    locating: 'Buscando sua localização…',
    openMap: 'Marcar no mapa',
    closeMap: 'Fechar o mapa',
    mapLoading: 'Abrindo o mapa…',
    mapUnavailable: 'O mapa está indisponível agora. Siga com a quadra e a referência, ou use sua localização.',
    tilesFailed: 'O mapa não carregou por completo. Você pode seguir só com a quadra e a referência.',
    mapHelp: 'Arraste o pino ou toque no mapa para marcar sua casa.',
    mapLabel: 'Mapa para marcar sua casa',
    set: 'Ponto marcado.',
    clear: 'Remover o ponto',
    denied: 'Sem permissão de localização. Tudo bem: siga com a quadra e a referência.',
    unavailable: 'A localização não está disponível neste aparelho. Siga com a quadra e a referência.',
    timeout: 'Não deu para pegar sua localização a tempo. Siga com a quadra e a referência, ou marque no mapa.',
    imprecise: (m: number) => `A localização veio imprecisa (cerca de ${m} m). Marque no mapa ou siga com a quadra e a referência.`,
    far: 'Sua localização está longe da rua escolhida, então não vamos usá-la. Marque no mapa o ponto da casa.',
    pinFar: 'Esse ponto está longe da rua escolhida. Confira se é mesmo o da sua casa.',
  },
  'es-UY': {
    title: 'Punto exacto (opcional)',
    help: 'Con la cuadra alcanza. Si querés, marcá el punto exacto de tu casa.',
    titleRequired: 'Punto de tu casa (obligatorio)',
    helpRequired: 'Como la calle no está en la lista, necesitamos el punto: usá tu ubicación o marcá la casa en el mapa.',
    gps: 'Usar mi ubicación',
    locating: 'Buscando tu ubicación…',
    openMap: 'Marcar en el mapa',
    closeMap: 'Cerrar el mapa',
    mapLoading: 'Abriendo el mapa…',
    mapUnavailable: 'El mapa no está disponible ahora. Seguí con la cuadra y la referencia, o usá tu ubicación.',
    tilesFailed: 'El mapa no cargó por completo. Podés seguir solo con la cuadra y la referencia.',
    mapHelp: 'Arrastrá el pin o tocá el mapa para marcar tu casa.',
    mapLabel: 'Mapa para marcar tu casa',
    set: 'Punto marcado.',
    clear: 'Quitar el punto',
    denied: 'Sin permiso de ubicación. No pasa nada: seguí con la cuadra y la referencia.',
    unavailable: 'La ubicación no está disponible en este dispositivo. Seguí con la cuadra y la referencia.',
    timeout: 'No se pudo obtener tu ubicación a tiempo. Seguí con la cuadra y la referencia, o marcá en el mapa.',
    imprecise: (m: number) => `La ubicación llegó imprecisa (unos ${m} m). Marcá en el mapa o seguí con la cuadra y la referencia.`,
    far: 'Tu ubicación está lejos de la calle elegida, así que no la vamos a usar. Marcá en el mapa el punto de la casa.',
    pinFar: 'Ese punto está lejos de la calle elegida. Fijate que sea el de tu casa.',
  },
} as const

type Note = 'denied' | 'unavailable' | 'timeout' | 'far' | 'pinFar' | 'tilesFailed' | 'mapUnavailable' | { imprecise: number }
type MapState = 'closed' | 'loading' | 'ready' | 'unavailable'

type Props = {
  locale: Locale
  /** `null` quando a rua não está no dataset: não há de onde conferir a distância. */
  street: Street | null
  /** Rua fora do dataset: o ponto deixa de ser opcional (sem ele não há coordenada). */
  required?: boolean
  /** Onde o pino nasce: o meio da quadra escolhida (ou um ponto sobre a rua). */
  center: LatLng
  value: PinFix | null
  onChange: (fix: PinFix | null) => void
  loadTileUrl?: TileUrlLoader
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

export function MapPin({ locale, street, required = false, center, value, onChange, loadTileUrl = fetchTileUrl }: Props) {
  const c = COPY[locale]
  const [mapState, setMapState] = useState<MapState>('closed')
  const [tileUrl, setTileUrl] = useState<string | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [locating, setLocating] = useState(false)
  const titleId = useId()
  const alive = useRef(0) // descarta resposta de um pedido que o cliente já abandonou

  const useMyLocation = () => {
    setNote(null)
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setNote('unavailable')
      return
    }
    const ticket = ++alive.current
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (ticket !== alive.current) return
        setLocating(false)
        const p = { lat: round6(pos.coords.latitude), lng: round6(pos.coords.longitude) }
        if (pos.coords.accuracy > MAX_ACCURACY_M) return setNote({ imprecise: Math.round(pos.coords.accuracy) })
        if ((street ? distanceToStreetMeters(street, p) : 0) > FAR_FROM_STREET_M) return setNote('far')
        onChange({ ...p, source: 'gps' })
      },
      (err) => {
        if (ticket !== alive.current) return
        setLocating(false)
        setNote(err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable')
      },
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 0 /* sempre uma leitura nova: quem tenta de novo depois de andar não pode receber a posição velha */ },
    )
  }

  const openMap = async () => {
    setNote(null)
    setMapState('loading')
    const url = await loadTileUrl()
    if (!url) {
      setMapState('unavailable')
      return
    }
    setTileUrl(url)
    setMapState('ready')
  }

  const placed = (p: LatLng) => {
    const point = { lat: round6(p.lat), lng: round6(p.lng) }
    setNote((street ? distanceToStreetMeters(street, point) : 0) > FAR_FROM_STREET_M ? 'pinFar' : null)
    onChange({ ...point, source: 'pin' })
  }

  const text = note === null ? null : typeof note === 'string' ? c[note] : c.imprecise(note.imprecise)
  const mapOpen = mapState !== 'closed'
  const btn = 'min-h-11 rounded-lg border border-borda px-4 text-base font-semibold disabled:opacity-50'

  return (
    <section className="grid gap-2" aria-labelledby={titleId}>
      <h3 id={titleId} className="text-base font-semibold">
        {required ? c.titleRequired : c.title}
      </h3>
      <p className="text-sm text-white/70">{required ? c.helpRequired : c.help}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} onClick={useMyLocation} disabled={locating}>
          {locating ? c.locating : c.gps}
        </button>
        <button
          type="button"
          className={btn}
          aria-expanded={mapOpen}
          onClick={() => (mapOpen ? setMapState('closed') : void openMap())}
        >
          {mapOpen ? c.closeMap : c.openMap}
        </button>
      </div>

      {mapState === 'loading' && <p className="text-sm text-white/70">{c.mapLoading}</p>}
      {mapState === 'unavailable' && <p className="text-sm text-sol">{c.mapUnavailable}</p>}
      {mapState === 'ready' && tileUrl && (
        <div className="grid gap-1">
          <p className="text-sm text-white/70">{c.mapHelp}</p>
          <LeafletMap
            tileUrl={tileUrl}
            position={value ?? center}
            onChange={placed}
            onTileError={() => setNote((n) => n ?? 'tilesFailed')}
            label={c.mapLabel}
          />
        </div>
      )}

      {value && (
        <p className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-semibold text-sol">{c.set}</span>
          <button
            type="button"
            className="min-h-11 underline"
            onClick={() => {
              setNote(null)
              onChange(null)
            }}
          >
            {c.clear}
          </button>
        </p>
      )}
      {text && (
        <p role="status" className="text-sm text-sol">
          {text}
        </p>
      )}
    </section>
  )
}
