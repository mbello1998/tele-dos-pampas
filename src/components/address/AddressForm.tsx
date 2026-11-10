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
import type { LatLng, Street } from '@/lib/geo/types'
import { BlockPicker, blockLabel, deriveBlocks, streetAnchor, UNKNOWN_BLOCK, type Block } from './BlockPicker'
import { MapPin, type PinFix, type TileUrlLoader } from './MapPin'
import { ReferenceField } from './ReferenceField'
import { StreetPicker, useStreetDatasets, type DatasetLoader } from './StreetPicker'

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
  const [tried, setTried] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const inFlight = useRef(false)
  const { load, start } = useStreetDatasets(loadDatasets)

  const blocks = useMemo(() => (street ? deriveBlocks(street) : []), [street])
  const anchor = useMemo(() => (street ? streetAnchor(street) : null), [street])
  const located = street && anchor ? resolveLocation(street, blockId, blocks, pin, anchor) : null
  const block = blocks.find((b) => b.id === blockId)
  const referenceRequired = located?.precision !== 'gps'
  const busy = status === 'saving' || status === 'saved'

  const reset = (next: Street | null) => {
    // outra rua = outra quadra e outro ponto: nada da rua anterior sobrevive
    setStreet(next)
    setBlockId(null)
    setPin(null)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (inFlight.current || !street || !located) return
    setTried(true)
    const ref = reference.trim()
    if (referenceRequired && ref === '') return

    const n = number.trim()
    const input: AddressInput = {
      label: label.trim() || (n ? `${street.name}, ${n}` : street.name),
      streetId: street.id,
      streetName: street.name,
      number: n,
      complement: complement.trim(),
      betweenStreets: block ? blockLabel(block, locale) : '',
      reference: ref,
      city: street.city,
      country: street.country,
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

  return (
    <form noValidate onSubmit={submit} className="grid gap-6" aria-busy={status === 'saving'}>
      <StreetPicker
        locale={locale}
        selected={street}
        onSelect={reset}
        onClear={() => reset(null)}
        load={load}
        onStart={start}
        onMissing={() => {}}
      />

      {street && anchor && (
        <>
          <BlockPicker blocks={blocks} value={blockId} onChange={setBlockId} locale={locale} />

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

          <MapPin
            key={street.id}
            locale={locale}
            street={street}
            center={block?.midpoint ?? anchor}
            value={pin}
            onChange={setPin}
            loadTileUrl={loadTileUrl}
          />

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
              placeholder={number.trim() ? `${street.name}, ${number.trim()}` : street.name}
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
          disabled={!street || !located || busy}
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
