'use client'

// Uma ponta da viagem, escolhida SEM CONTA. Não salva nada: devolve o ponto para a tela, que o manda ao
// servidor só para cotar. É a composição dos componentes de endereço que já existem, na mesma ordem de
// precisão da spec 9.2 — rua + quadra, pino/GPS, referência em texto livre — mais o atalho "usar minha
// localização", que é o que a pessoa faz primeiro quando abre um app de corrida.
//
// O que NÃO está aqui, de propósito: salvar em `addresses` (precisa de conta) e qualquer conta de preço.
import { useMemo, useState } from 'react'
import {
  BlockPicker,
  blockLabel,
  deriveBlocks,
  distanceToStreetMeters,
  streetAnchor,
  UNKNOWN_BLOCK,
  type Block,
} from '@/components/address/BlockPicker'
import { MapPin, MAX_ACCURACY_M, type PinFix } from '@/components/address/MapPin'
import { ReferenceField } from '@/components/address/ReferenceField'
import { CITY_NAME, COUNTRY_NAME, FLAG, StreetPicker, type Load } from '@/components/address/StreetPicker'
import type { City, Country, LatLng, Street, StreetDataset } from '@/lib/geo/types'
import type { Locale } from '@/lib/money/format'
import type { TripPoint } from '@/lib/pricing/trip'
import { REQUEST_COPY } from './copy'

const COUNTRY_OF_CITY: Record<City, Country> = { quarai: 'BR', artigas: 'UY' }
const CITIES: City[] = ['quarai', 'artigas']
const CITY_CENTER: Record<City, LatLng> = {
  quarai: { lat: -30.3875, lng: -56.4528 },
  artigas: { lat: -30.4, lng: -56.47 },
}

/** Além disto, o GPS não diz de que lado da ponte a pessoa está, e o lado decide moeda e travessia. */
const GPS_MAX_FROM_STREET_M = 2000

const COPY = {
  'pt-BR': {
    ok: 'Usar este endereço',
    city: 'Em que cidade?',
    streetName: 'Nome da rua',
    missing: 'Rua que não está na lista',
    missingHelp: 'Escreva o nome da rua, marque o ponto no mapa e conte uma referência: é o que o motoboy vai ter.',
    back: 'Voltar à busca de rua',
    pinNeeded: 'Falta marcar o ponto no mapa (ou usar sua localização).',
    number: 'Número (se tiver)',
  },
  'es-UY': {
    ok: 'Usar esta dirección',
    city: '¿En qué ciudad?',
    streetName: 'Nombre de la calle',
    missing: 'Calle que no está en la lista',
    missingHelp: 'Escribí el nombre de la calle, marcá el punto en el mapa y contá una referencia: es lo que va a tener el repartidor.',
    back: 'Volver a la búsqueda de calle',
    pinNeeded: 'Falta marcar el punto en el mapa (o usar tu ubicación).',
    number: 'Número (si tiene)',
  },
} as const

/** A ponta escolhida: o que o servidor precisa (`point`) e o que a tela mostra. */
export type ChosenPlace = {
  point: TripPoint
  /** Linha de cima do resumo: a rua, ou "minha localização". */
  label: string
  /** Linha de baixo: cidade, país e o que mais ajude a reconhecer. */
  detail: string
}

/** A rua mais próxima de um ponto, nos dois datasets. É assim que o GPS descobre de que lado da ponte está. */
export function nearestStreet(p: LatLng, datasets: StreetDataset[]): { street: Street; meters: number } | null {
  let best: { street: Street; meters: number } | null = null
  for (const d of datasets) {
    for (const street of d.streets) {
      const meters = distanceToStreetMeters(street, p)
      if (!best || meters < best.meters) best = { street, meters }
    }
  }
  return best
}

/**
 * A rua mais próxima EM CADA PAÍS. Serve a uma pergunta que a precisão sozinha não responde: com um erro de
 * 3 km, de que lado do rio a pessoa está? Se o outro país cabe dentro do círculo de erro, não está decidido —
 * e o lado decide moeda, travessia e preço. Se não cabe, a cidade está decidida mesmo com GPS ruim.
 */
export function nearestByCountry(p: LatLng, datasets: StreetDataset[]): Map<string, { street: Street; meters: number }> {
  const best = new Map<string, { street: Street; meters: number }>()
  for (const d of datasets) {
    for (const street of d.streets) {
      if (!street.country) continue
      const meters = distanceToStreetMeters(street, p)
      const current = best.get(street.country)
      if (!current || meters < current.meters) best.set(street.country, { street, meters })
    }
  }
  return best
}

const field = 'min-h-11 w-full rounded-lg border border-white/25 bg-white/5 px-3 text-base'

type Props = {
  locale: Locale
  load: Load
  onStart: () => void
  onChoose: (place: ChosenPlace) => void
  /** O atalho de GPS só aparece na ponta de origem: é lá que "minha localização" faz sentido. */
  gps?: { pending: boolean; note: string | null; onUse: () => void } | null
}

export function PointPicker({ locale, load, onStart, onChoose, gps }: Props) {
  const c = COPY[locale]
  const r = REQUEST_COPY[locale]
  const [street, setStreet] = useState<Street | null>(null)
  const [blockId, setBlockId] = useState<string | null>(null)
  const [pin, setPin] = useState<PinFix | null>(null)
  const [number, setNumber] = useState('')
  const [reference, setReference] = useState('')
  const [tried, setTried] = useState(false)
  const [missing, setMissing] = useState(false)
  const [city, setCity] = useState<City | null>(null)
  const [streetText, setStreetText] = useState('')

  const blocks = useMemo(() => (street ? deriveBlocks(street) : []), [street])
  const anchor = useMemo(() => (street ? streetAnchor(street) : null), [street])

  const reset = (next: Street | null) => {
    setStreet(next)
    setBlockId(null)
    setPin(null)
  }

  const block: Block | undefined = blocks.find((b) => b.id === blockId)
  const located: (LatLng & { precision: 'gps' | 'quadra' | 'rua' }) | null = missing
    ? pin
      ? { lat: pin.lat, lng: pin.lng, precision: 'gps' }
      : null
    : pin
      ? { lat: pin.lat, lng: pin.lng, precision: 'gps' }
      : blockId === UNKNOWN_BLOCK && anchor
        ? { ...anchor, precision: 'rua' }
        : block
          ? { ...block.midpoint, precision: 'quadra' }
          : null

  // A referência é exigida só onde ela é o ÚNICO jeito de achar o lugar: rua fora do mapa, ou nem quadra nem
  // pino. Com rua e quadra escolhidas, o motoboy já sabe onde é, e o preço não deve esperar por texto.
  const referenceRequired = missing || located?.precision === 'rua'
  const missingReference = referenceRequired && reference.trim() === ''
  const place = missing ? { id: null, name: streetText.trim(), city, country: city ? COUNTRY_OF_CITY[city] : null } : street
  const ready = Boolean(located) && Boolean(place?.name) && Boolean(place?.city) && !missingReference

  const confirm = () => {
    setTried(true)
    if (!located || !place?.city || !place.country || !place.name || missingReference) return
    const n = number.trim()
    const ref = reference.trim()
    const detail = [
      `${FLAG[place.country]} ${CITY_NAME[place.city]} · ${COUNTRY_NAME[locale][place.country]}`,
      !missing && block ? blockLabel(block, locale) : null,
      ref || null,
    ]
      .filter(Boolean)
      .join(' · ')
    onChoose({
      point: { city: place.city, country: place.country, lat: located.lat, lng: located.lng },
      label: n ? `${place.name}, ${n}` : place.name,
      detail,
    })
  }

  const showRest = missing || (street !== null && anchor !== null)
  const mapCenter = missing ? (city ? CITY_CENTER[city] : null) : (block?.midpoint ?? anchor)

  return (
    <div className="grid gap-5">
      {gps && (
        <div className="grid gap-1.5">
          <button
            type="button"
            onClick={gps.onUse}
            disabled={gps.pending}
            className="flex min-h-12 items-center justify-center gap-2 rounded-lg border border-rio bg-rio/15 px-4 text-base font-semibold text-white disabled:opacity-60"
          >
            <span aria-hidden="true" className="size-2.5 rounded-full bg-rio" />
            {gps.pending ? r.locating : r.use_gps}
          </button>
          {gps.note && (
            <p role="status" className="text-sm text-sol">
              {gps.note}
            </p>
          )}
        </div>
      )}

      {missing ? (
        <section className="grid gap-4" aria-label={c.missing}>
          <p className="text-sm text-white/70">{c.missingHelp}</p>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-base font-semibold">{c.city}</legend>
            {CITIES.map((k) => (
              <label
                key={k}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-white/20 px-3 py-2 has-[:checked]:border-sol has-[:checked]:bg-white/5"
              >
                <input
                  type="radio"
                  name="cidade"
                  value={k}
                  checked={city === k}
                  onChange={() => {
                    setCity(k)
                    setPin(null)
                  }}
                  className="size-5 accent-[var(--color-sol)]"
                />
                <span className="text-base">
                  {FLAG[COUNTRY_OF_CITY[k]]} {CITY_NAME[k]} · {COUNTRY_NAME[locale][COUNTRY_OF_CITY[k]]}
                </span>
              </label>
            ))}
          </fieldset>
          <label className="grid gap-1">
            <span className="text-base font-semibold">{c.streetName}</span>
            <input
              type="text"
              autoComplete="off"
              maxLength={120}
              value={streetText}
              onChange={(e) => setStreetText(e.target.value)}
              className={field}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              setMissing(false)
              setCity(null)
              setStreetText('')
              setPin(null)
            }}
            className="min-h-11 justify-self-start text-base font-semibold underline"
          >
            {c.back}
          </button>
        </section>
      ) : (
        <StreetPicker
          locale={locale}
          selected={street}
          onSelect={reset}
          onClear={() => reset(null)}
          load={load}
          onStart={onStart}
          onMissing={() => {
            onStart()
            reset(null)
            setMissing(true)
          }}
        />
      )}

      {showRest && (
        <>
          {!missing && street && <BlockPicker blocks={blocks} value={blockId} onChange={setBlockId} locale={locale} />}

          <label className="grid gap-1">
            <span className="text-base font-semibold">{c.number}</span>
            <input
              type="text"
              autoComplete="off"
              maxLength={20}
              inputMode="numeric"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              className={`${field} sm:max-w-40`}
            />
          </label>

          {mapCenter && (
            <MapPin
              key={missing ? `missing-${city}` : street!.id}
              locale={locale}
              street={missing ? null : street}
              required={missing}
              center={mapCenter}
              value={pin}
              onChange={setPin}
            />
          )}
          {missing && city && !pin && <p className="text-sm text-sol">{c.pinNeeded}</p>}

          <ReferenceField
            locale={locale}
            value={reference}
            onChange={setReference}
            required={referenceRequired}
            showError={tried}
          />
        </>
      )}

      <button
        type="button"
        onClick={confirm}
        disabled={!ready}
        className="min-h-12 rounded-lg bg-sol px-4 text-base font-bold text-noite transition-transform active:scale-[0.985] disabled:opacity-25"
      >
        {c.ok}
      </button>
    </div>
  )
}

/** Fora de um raio onde há ruas conhecidas, a posição do GPS não serve para cobrar. */
export { GPS_MAX_FROM_STREET_M, MAX_ACCURACY_M }
