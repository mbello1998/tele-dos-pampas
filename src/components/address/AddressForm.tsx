'use client'

// O formulário de endereço, nas três camadas de precisão da spec 9.2, nesta ordem:
//   1. rua + quadra  -> precision 'quadra', coordenada no meio do trecho
//   2. pino / GPS    -> precision 'gps', coordenada do pino
//   3. referência em texto livre (obrigatória sem GPS)
// Sempre sai com lat/lng: sem GPS a coordenada vem do meio da quadra (ou de um ponto sobre a rua), porque
// um endereço sem coordenada não pode ser cotado.
import { useMemo, useRef, useState, type FormEvent } from 'react'
import { saveAddress, type Address, type AddressInput, type AddressPrecision } from '@/actions/addresses'
import type { Locale } from '@/lib/landing/content'
import type { City, Country, LatLng, Street, StreetDataset } from '@/lib/geo/types'
import { BlockPicker, blockLabel, deriveBlocks, distanceToStreetMeters, streetAnchor, UNKNOWN_BLOCK, type Block } from './BlockPicker'
import { MapPin, type PinFix, type TileUrlLoader } from './MapPin'
import { ReferenceField } from './ReferenceField'
import { CITY_NAME, COUNTRY_NAME, FLAG, StreetPicker, useStreetDatasets, type DatasetLoader } from './StreetPicker'

const COPY = {
  'pt-BR': {
    number: 'Número (se tiver)',
    numberHelp: 'Muita casa não tem número na parede. Pode deixar em branco.',
    complement: 'Complemento',
    label: 'Apelido do endereço',
    labelHelp: 'Para achar de novo no próximo pedido. Ex.: casa, mãe, trabalho.',
    save: 'Salvar endereço',
    saving: 'Salvando…',
    failed: 'Não foi possível salvar. Confira a conexão e se você entrou na sua conta, e tente de novo.',
    missingTitle: 'Rua que não está na lista',
    missingHelp:
      'Escreva o nome da rua, marque o ponto da sua casa e conte uma referência. Sem a rua no mapa, o ponto e a referência são tudo o que o motoboy tem. Vamos avisar o mapa (OpenStreetMap) para incluir sua rua.',
    cityLegend: 'Em que cidade?',
    streetName: 'Nome da rua',
    back: 'Voltar à busca de rua',
    cityFirst: 'Escolha a cidade para abrir o mapa.',
    pinNeeded: 'Falta marcar o ponto da casa (no mapa ou pela sua localização).',
    mismatch: (found: string, chosen: string) =>
      `Esse ponto parece estar em ${found}, mas você escolheu ${chosen}. Confira a cidade ou o ponto no mapa.`,
  },
  'es-UY': {
    number: 'Número (si tiene)',
    numberHelp: 'Muchas casas no tienen número en la pared. Podés dejarlo en blanco.',
    complement: 'Complemento',
    label: 'Apodo de la dirección',
    labelHelp: 'Para encontrarla de nuevo en el próximo pedido. Ej.: casa, mamá, trabajo.',
    save: 'Guardar dirección',
    saving: 'Guardando…',
    failed: 'No se pudo guardar. Revisá la conexión y si ingresaste a tu cuenta, e intentá de nuevo.',
    missingTitle: 'Calle que no está en la lista',
    missingHelp:
      'Escribí el nombre de la calle, marcá el punto de tu casa y contá una referencia. Sin la calle en el mapa, el punto y la referencia son todo lo que tiene el repartidor. Vamos a avisar al mapa (OpenStreetMap) para que incluya tu calle.',
    cityLegend: '¿En qué ciudad?',
    streetName: 'Nombre de la calle',
    back: 'Volver a la búsqueda de calle',
    cityFirst: 'Elegí la ciudad para abrir el mapa.',
    pinNeeded: 'Falta marcar el punto de la casa (en el mapa o con tu ubicación).',
    mismatch: (found: string, chosen: string) =>
      `Ese punto parece estar en ${found}, pero elegiste ${chosen}. Revisá la ciudad o el punto en el mapa.`,
  },
} as const

export type Located = LatLng & { precision: AddressPrecision }

/**
 * De onde sai a coordenada, em ordem de precisão: o pino/GPS do cliente; senão o meio da quadra
 * escolhida; senão (cliente não sabe a quadra) um ponto sobre a rua. `null` = ainda sem localização.
 */
export function resolveLocation(
  street: Street,
  blockId: string | null,
  blocks: Block[],
  pin: PinFix | null,
  anchor: LatLng = streetAnchor(street),
): Located | null {
  if (pin) return { lat: pin.lat, lng: pin.lng, precision: 'gps' }
  if (blockId === UNKNOWN_BLOCK) return { ...anchor, precision: 'rua' }
  const block = blocks.find((b) => b.id === blockId)
  return block ? { ...block.midpoint, precision: 'quadra' } : null
}

const COUNTRY_OF_CITY: Record<City, Country> = { quarai: 'BR', artigas: 'UY' }
const CITIES: City[] = ['quarai', 'artigas']
/** Onde o mapa abre quando não há rua nem quadra para centrar: o centro de cada cidade (praças centrais). */
const CITY_CENTER: Record<City, LatLng> = {
  quarai: { lat: -30.3875, lng: -56.4528 },
  artigas: { lat: -30.4, lng: -56.47 },
}

/** Dentro de 1,5 km de alguma rua, o lado da ponte do pino é confiável; além disso, não há como saber. */
const BORDER_CHECK_MAX_M = 1500
/** O pino só contradiz a cidade escolhida se estiver claramente mais perto de ruas do outro país. */
const BORDER_MARGIN_M = 50
const BORDER_NEAR_M = 200

/**
 * Sem rua escolhida, o país vem da cidade que o cliente marcou, e o país decide moeda e taxa de travessia.
 * Para um cliente que marca "Artigas" estando em Quaraí (ou o contrário) cobrar errado seria silencioso,
 * então o pino é conferido contra as ruas dos dois datasets. Devolve a cidade do outro lado se o pino
 * estiver claramente lá; `null` se bate com a escolha, ou se está longe demais de tudo para saber.
 */
export function borderMismatch(pin: LatLng, chosen: City, datasets: StreetDataset[]): City | null {
  const nearest: Record<City, number> = { quarai: Infinity, artigas: Infinity }
  for (const d of datasets) {
    for (const st of d.streets) nearest[st.city] = Math.min(nearest[st.city], distanceToStreetMeters(st, pin))
  }
  const other: City = chosen === 'quarai' ? 'artigas' : 'quarai'
  const dChosen = nearest[chosen]
  const dOther = nearest[other]
  if (dOther > BORDER_CHECK_MAX_M) return null
  return dChosen > BORDER_NEAR_M && dOther + BORDER_MARGIN_M < dChosen ? other : null
}

const field = 'min-h-11 w-full rounded-lg border border-white/25 bg-transparent px-3 text-base'

type Props = {
  onDone: (address: Address) => void
  locale?: Locale
  /** Só para testes: de onde vem o dataset de ruas. Por padrão, import() dinâmico no primeiro foco. */
  loadDatasets?: DatasetLoader
  /** Só para testes: de onde vem a URL dos tiles. Por padrão, settings['map.tile_url']. */
  loadTileUrl?: TileUrlLoader
}

export function AddressForm({ onDone, locale = 'pt-BR', loadDatasets, loadTileUrl }: Props) {
  const c = COPY[locale]
  const [street, setStreet] = useState<Street | null>(null)
  const [blockId, setBlockId] = useState<string | null>(null)
  const [pin, setPin] = useState<PinFix | null>(null)
  const [number, setNumber] = useState('')
  const [complement, setComplement] = useState('')
  const [label, setLabel] = useState('')
  const [reference, setReference] = useState('')
  // "Não encontrei minha rua": rua em texto livre, cidade escolhida à mão, ponto e referência obrigatórios
  const [missing, setMissing] = useState(false)
  const [city, setCity] = useState<City | null>(null)
  const [streetText, setStreetText] = useState('')
  const [tried, setTried] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const inFlight = useRef(false)
  const { load, start } = useStreetDatasets(loadDatasets)

  const blocks = useMemo(() => (street ? deriveBlocks(street) : []), [street])
  const anchor = useMemo(() => (street ? streetAnchor(street) : null), [street])
  const located: Located | null = missing
    ? pin
      ? { lat: pin.lat, lng: pin.lng, precision: 'gps' }
      : null
    : street && anchor
      ? resolveLocation(street, blockId, blocks, pin, anchor)
      : null
  const block = blocks.find((b) => b.id === blockId)
  // rua ausente do dataset: a referência é obrigatória mesmo com GPS, é tudo o que o entregador tem
  const referenceRequired = missing || located?.precision !== 'gps'
  const otherSide = missing && city && pin && load.state === 'ready' ? borderMismatch(pin, city, load.datasets) : null
  const ready = missing
    ? city !== null && streetText.trim() !== '' && located !== null && otherSide === null
    : street !== null && located !== null
  const busy = status === 'saving' || status === 'saved'

  const reset = (next: Street | null) => {
    // outra rua = outra quadra e outro ponto: nada da rua anterior sobrevive
    setStreet(next)
    setBlockId(null)
    setPin(null)
  }

  const enterMissing = () => {
    start() // o pino vai ser conferido contra as ruas dos dois lados da ponte
    reset(null)
    setMissing(true)
  }
  const leaveMissing = () => {
    setMissing(false)
    setCity(null)
    setStreetText('')
    setPin(null)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (inFlight.current || !ready || !located) return
    setTried(true)
    const ref = reference.trim()
    if (referenceRequired && ref === '') return

    const n = number.trim()
    const place = missing ? { id: null, name: streetText.trim(), city: city!, country: COUNTRY_OF_CITY[city!] } : street!
    const input: AddressInput = {
      label: label.trim() || (n ? `${place.name}, ${n}` : place.name),
      streetId: place.id,
      streetName: place.name,
      number: n,
      complement: complement.trim(),
      betweenStreets: !missing && block ? blockLabel(block, locale) : '',
      reference: ref,
      city: place.city,
      country: place.country,
      lat: located.lat,
      lng: located.lng,
      precision: located.precision,
    }
    inFlight.current = true
    setStatus('saving')
    try {
      const saved = await saveAddress(input)
      setStatus('saved')
      onDone(saved)
    } catch {
      inFlight.current = false
      setStatus('failed')
    }
  }

  const placeName = missing ? streetText.trim() : street?.name ?? ''
  const showRest = missing ? true : street !== null && anchor !== null
  const mapCenter = missing ? (city ? CITY_CENTER[city] : null) : (block?.midpoint ?? anchor)

  return (
    <form noValidate onSubmit={submit} className="grid gap-6" aria-busy={status === 'saving'}>
      {missing ? (
        <section className="grid gap-4" aria-labelledby="missing-title">
          <h2 id="missing-title" className="text-base font-semibold">
            {c.missingTitle}
          </h2>
          <p className="text-sm text-white/70">{c.missingHelp}</p>
          <fieldset className="grid gap-2">
            <legend className="text-base font-semibold">{c.cityLegend}</legend>
            {CITIES.map((k) => (
              <label
                key={k}
                className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-white/20 px-3 py-2 has-[:checked]:border-sol has-[:checked]:bg-white/5"
              >
                <input
                  type="radio"
                  name="city"
                  value={k}
                  checked={city === k}
                  onChange={() => {
                    setCity(k)
                    setPin(null) // o ponto marcado numa cidade não vale para a outra
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
              name="streetName"
              type="text"
              autoComplete="off"
              maxLength={120}
              required
              value={streetText}
              onChange={(e) => setStreetText(e.target.value)}
              className={field}
            />
          </label>
          <button
            type="button"
            onClick={leaveMissing}
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
          onStart={start}
          onMissing={enterMissing}
        />
      )}

      {showRest && (
        <>
          {!missing && street && <BlockPicker blocks={blocks} value={blockId} onChange={setBlockId} locale={locale} />}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1">
              <span className="text-base font-semibold">{c.number}</span>
              <input
                name="number"
                type="text"
                autoComplete="off"
                maxLength={20}
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                className={field}
              />
              <span className="text-sm text-white/70">{c.numberHelp}</span>
            </label>
            <label className="grid gap-1">
              <span className="text-base font-semibold">{c.complement}</span>
              <input
                name="complement"
                type="text"
                autoComplete="off"
                maxLength={80}
                value={complement}
                onChange={(e) => setComplement(e.target.value)}
                className={field}
              />
            </label>
          </div>

          {mapCenter ? (
            <MapPin
              key={missing ? `missing-${city}` : street!.id}
              locale={locale}
              street={missing ? null : street}
              required={missing}
              center={mapCenter}
              value={pin}
              onChange={setPin}
              loadTileUrl={loadTileUrl}
            />
          ) : (
            <p className="text-sm text-white/70">{c.cityFirst}</p>
          )}
          {otherSide && city && (
            <p role="alert" className="text-sm text-brasa">
              {c.mismatch(`${CITY_NAME[otherSide]} (${COUNTRY_NAME[locale][COUNTRY_OF_CITY[otherSide]]})`, CITY_NAME[city])}
            </p>
          )}
          {missing && city && !pin && <p className="text-sm text-sol">{c.pinNeeded}</p>}

          <ReferenceField
            locale={locale}
            value={reference}
            onChange={setReference}
            required={referenceRequired}
            showError={tried}
          />

          <label className="grid gap-1">
            <span className="text-base font-semibold">{c.label}</span>
            <input
              name="label"
              type="text"
              autoComplete="off"
              maxLength={40}
              placeholder={number.trim() ? `${placeName}, ${number.trim()}` : placeName}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className={field}
            />
            <span className="text-sm text-white/70">{c.labelHelp}</span>
          </label>
        </>
      )}

      <div className="grid gap-2">
        <button
          type="submit"
          disabled={!ready || busy}
          className="min-h-12 rounded-lg bg-sol px-4 text-base font-bold text-noite disabled:opacity-50"
        >
          {c.save}
        </button>
        <p role="status" className="min-h-5 text-sm">
          {status === 'saving' && c.saving}
          {status === 'failed' && <span className="text-brasa">{c.failed}</span>}
        </p>
      </div>
    </form>
  )
}
