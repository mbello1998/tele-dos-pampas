'use client'

// Busca de rua nas duas cidades ao mesmo tempo. O dataset (cerca de 600 kB de JSON) só é buscado quando
// o campo recebe foco, por import() dinâmico: fica num chunk próprio e fora do JS inicial da página.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Locale } from '@/lib/landing/content'
import { searchStreets } from '@/lib/geo/search'
import type { City, Country, Street, StreetDataset } from '@/lib/geo/types'

export type DatasetLoader = () => Promise<StreetDataset[]>

/** O único lugar que importa o JSON. `as unknown`: o tipo inferido de 600 kB de literais não ajuda ninguém. */
export const loadStreetDatasets: DatasetLoader = async () => {
  const [quarai, artigas] = await Promise.all([
    import('../../../public/data/quarai.json'),
    import('../../../public/data/artigas.json'),
  ])
  return [quarai.default, artigas.default] as unknown as StreetDataset[]
}

const MIN_CHARS = 3

export const CITY_NAME: Record<City, string> = { quarai: 'Quaraí', artigas: 'Artigas' }
export const FLAG: Record<Country, string> = { BR: '🇧🇷', UY: '🇺🇾' }
export const COUNTRY_NAME: Record<Locale, Record<Country, string>> = {
  'pt-BR': { BR: 'Brasil', UY: 'Uruguai' },
  'es-UY': { BR: 'Brasil', UY: 'Uruguay' },
}

const COPY = {
  'pt-BR': {
    label: 'Rua ou avenida',
    placeholder: 'Digite 3 letras do nome',
    minHint: 'Digite ao menos 3 letras.',
    loading: 'Carregando ruas…',
    failed: 'Não foi possível carregar as ruas.',
    retry: 'Tentar de novo',
    none: 'Nenhuma rua encontrada. Tente outra grafia.',
    near: (h: string) => `perto de ${h}`,
    change: 'Trocar',
    chosen: 'Rua escolhida',
    missing: 'Não encontrei minha rua',
  },
  'es-UY': {
    label: 'Calle o avenida',
    placeholder: 'Escribí 3 letras del nombre',
    minHint: 'Escribí al menos 3 letras.',
    loading: 'Cargando calles…',
    failed: 'No se pudieron cargar las calles.',
    retry: 'Intentar de nuevo',
    none: 'No se encontró ninguna calle. Probá otra grafía.',
    near: (h: string) => `cerca de ${h}`,
    change: 'Cambiar',
    chosen: 'Calle elegida',
    missing: 'No encuentro mi calle',
  },
} as const

/** "🇧🇷 Quaraí · Brasil": cidade e país sempre juntos, porque a lista mistura os dois lados da ponte. */
export function placeLabel(street: Pick<Street, 'city' | 'country'>, locale: Locale): string {
  return `${FLAG[street.country]} ${CITY_NAME[street.city]} · ${COUNTRY_NAME[locale][street.country]}`
}

export type Load = { state: 'idle' } | { state: 'loading' } | { state: 'ready'; datasets: StreetDataset[] } | { state: 'error' }

/**
 * Estado de carga do dataset. Mora no formulário (e não no campo) porque o fluxo "não encontrei minha
 * rua" também precisa dele, para conferir de que lado da ponte o pino caiu. `start` é idempotente: só o
 * primeiro foco (ou o botão de tentar de novo, depois de uma falha) dispara o import().
 */
export function useStreetDatasets(loadDatasets: DatasetLoader = loadStreetDatasets) {
  const [load, setLoad] = useState<Load>({ state: 'idle' })
  const started = useRef(false)
  const start = useCallback(() => {
    if (started.current) return
    started.current = true
    setLoad({ state: 'loading' })
    loadDatasets().then(
      (datasets) => setLoad({ state: 'ready', datasets }),
      () => {
        started.current = false // o próximo foco (ou o botão) tenta de novo
        setLoad({ state: 'error' })
      },
    )
  }, [loadDatasets])
  return { load, start }
}

type Props = {
  locale: Locale
  selected: Street | null
  onSelect: (street: Street) => void
  onClear: () => void
  load: Load
  onStart: () => void
  /** "Não encontrei minha rua": a saída para quem mora numa rua que o OSM não tem. */
  onMissing: () => void
}

export function StreetPicker({ locale, selected, onSelect, onClear, load, onStart: start, onMissing }: Props) {
  const c = COPY[locale]
  const uid = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const hits = useMemo(
    () => (load.state === 'ready' && query.trim().length >= MIN_CHARS ? searchStreets(query, load.datasets) : []),
    [load, query],
  )
  useEffect(() => setActive(0), [hits])

  const choose = (street: Street) => {
    setOpen(false)
    setQuery('')
    onSelect(street)
  }

  if (selected) {
    return (
      <div className="grid gap-1">
        <span className="text-base font-semibold">{c.chosen}</span>
        <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-sol px-3 py-2">
          <div className="min-w-0">
            <p className="break-words text-base font-semibold">{selected.name}</p>
            <p className="text-sm text-white/70">
              {placeLabel(selected, locale)}
              {selected.nearHint ? ` · ${c.near(selected.nearHint)}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              onClear()
              requestAnimationFrame(() => inputRef.current?.focus())
            }}
            className="min-h-11 shrink-0 rounded-lg border border-borda px-3 text-sm font-semibold"
          >
            {c.change}
          </button>
        </div>
      </div>
    )
  }

  const listId = `${uid}-list`
  const showList = open && hits.length > 0
  const typed = query.trim().length
  return (
    <div className="grid gap-1">
      <label htmlFor={`${uid}-input`} className="text-base font-semibold">
        {c.label}
      </label>
      <div className="relative">
        <input
          ref={inputRef}
          id={`${uid}-input`}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? `${uid}-opt-${active}` : undefined}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="search"
          placeholder={c.placeholder}
          value={query}
          onFocus={() => {
            start()
            setOpen(true)
          }}
          onBlur={() => setOpen(false)}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && hits.length) {
              e.preventDefault()
              setOpen(true)
              setActive((a) => (a + 1) % hits.length)
            } else if (e.key === 'ArrowUp' && hits.length) {
              e.preventDefault()
              setActive((a) => (a - 1 + hits.length) % hits.length)
            } else if (e.key === 'Enter' && showList) {
              e.preventDefault()
              choose(hits[active])
            } else if (e.key === 'Enter') {
              e.preventDefault() // Enter no campo de busca nunca envia o formulário
            } else if (e.key === 'Escape') setOpen(false)
          }}
          className="min-h-11 w-full rounded-lg border border-borda bg-transparent px-3 text-base"
        />
        <ul
          id={listId}
          role="listbox"
          aria-label={c.label}
          hidden={!showList}
          // mousedown não pode tirar o foco do campo, senão o onBlur fecha a lista antes do clique
          onMouseDown={(e) => e.preventDefault()}
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-auto rounded-lg border border-borda bg-noite shadow-lg"
        >
          {hits.map((h, i) => (
            <li
              key={h.id}
              id={`${uid}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              onClick={() => choose(h)}
              className={`min-h-11 cursor-pointer px-3 py-2 ${i === active ? 'bg-white/10' : ''}`}
            >
              <span className="block break-words text-base font-semibold">{h.name}</span>
              <span className="block text-sm text-white/70">
                {placeLabel(h, locale)}
                {h.nearHint ? ` · ${c.near(h.nearHint)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p role="status" className="min-h-5 text-sm text-white/70">
        {load.state === 'loading' && c.loading}
        {load.state === 'error' && (
          <>
            {c.failed}{' '}
            <button type="button" onClick={start} className="min-h-11 font-semibold underline">
              {c.retry}
            </button>
          </>
        )}
        {load.state === 'ready' && typed > 0 && typed < MIN_CHARS && c.minHint}
        {load.state === 'ready' && typed >= MIN_CHARS && hits.length === 0 && c.none}
      </p>
      <button type="button" onClick={onMissing} className="min-h-11 justify-self-start text-base font-semibold underline">
        {c.missing}
      </button>
    </div>
  )
}
