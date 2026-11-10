'use client'

// Mapa com um pino arrastável. Só é importado por next/dynamic (ssr: false) quando o cliente pede o mapa,
// então o Leaflet e o CSS dele ficam num chunk à parte. Sem Google Maps: tiles de uma URL que vem de
// settings['map.tile_url'] (spec 9.3). Nenhuma imagem de marcador: o pino é um divIcon em CSS, porque o
// caminho padrão dos ícones do Leaflet quebra sob bundler.
import * as L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useRef } from 'react'
import type { LatLng } from '@/lib/geo/types'

type Props = {
  /** Modelo de tiles, ex.: https://tile.openstreetmap.org/{z}/{x}/{y}.png */
  tileUrl: string
  /** Onde o pino está. Mudar este valor move o pino; arrastar ou tocar chama `onChange`. */
  position: LatLng
  onChange: (p: LatLng) => void
  /** Chamado uma vez, na primeira falha de tile: o formulário avisa e segue sem o mapa. */
  onTileError?: () => void
  label: string
}

const ZOOM = 18
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'

const PIN = L.divIcon({
  className: '',
  html: '<div style="width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#F2A516;border:3px solid #0B0F0D;box-shadow:0 1px 5px rgba(0,0,0,.6)"></div>',
  iconSize: [28, 28],
  iconAnchor: [4, 28],
})

export default function LeafletMap({ tileUrl, position, onChange, onTileError, label }: Props) {
  const el = useRef<HTMLDivElement>(null)
  const marker = useRef<L.Marker | null>(null)
  const map = useRef<L.Map | null>(null)
  // callbacks por ref: o mapa é criado uma vez, e não pode ser refeito a cada render do pai
  const onChangeRef = useRef(onChange)
  const onTileErrorRef = useRef(onTileError)
  const start = useRef(position)
  useEffect(() => {
    onChangeRef.current = onChange
    onTileErrorRef.current = onTileError
  })

  useEffect(() => {
    if (!el.current) return
    const m = L.map(el.current, { center: start.current, zoom: ZOOM, attributionControl: true })
    let failed = false
    L.tileLayer(tileUrl, { maxZoom: 19, attribution: ATTRIBUTION })
      .on('tileerror', () => {
        if (failed) return
        failed = true
        onTileErrorRef.current?.()
      })
      .addTo(m)
    const pin = L.marker(start.current, { draggable: true, icon: PIN, keyboard: false }).addTo(m)
    pin.on('dragend', () => onChangeRef.current(pin.getLatLng()))
    m.on('click', (e: L.LeafletMouseEvent) => {
      pin.setLatLng(e.latlng)
      onChangeRef.current(e.latlng)
    })
    marker.current = pin
    map.current = m
    // o contêiner acabou de ganhar tamanho: sem isto o Leaflet calcula tiles para 0 px
    requestAnimationFrame(() => m.invalidateSize())
    return () => {
      m.remove()
      marker.current = null
      map.current = null
    }
  }, [tileUrl])

  useEffect(() => {
    const pin = marker.current
    if (!pin) return
    const cur = pin.getLatLng()
    if (Math.abs(cur.lat - position.lat) > 1e-7 || Math.abs(cur.lng - position.lng) > 1e-7) {
      pin.setLatLng(position)
      map.current?.panTo(position)
    }
  }, [position])

  return <div ref={el} role="application" aria-label={label} className="isolate h-72 w-full overflow-hidden rounded-lg" />
}
