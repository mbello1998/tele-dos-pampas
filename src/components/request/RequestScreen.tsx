'use client'

// A TELA INICIAL: pedir uma corrida. Abre no formulário, como abre um app de corrida, e sem conta.
//
// Ordem em que a pessoa pensa, e ordem na tela: que serviço, de onde, para onde, quanto custa, confirmar.
// O preço aparece sozinho no instante em que as duas pontas existem — ninguém aperta "calcular".
//
// Nada de preço é calculado aqui: `quoteTrip` manda duas coordenadas ao servidor, que mede a rota e pede o
// valor ao banco. O que esta tela faz com dinheiro é formatar (formatMoney) e alinhar (.preco).
//
// Movimento: só `transform` e `opacity`, em CSS (src/styles/motion.css), sem GSAP e sem Lenis nesta rota.
// O público é Android de entrada com dados contados, e esta é a tela que precisa abrir rápido.
import { useEffect, useMemo, useRef, useState } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { quoteTrip, requestNextPath } from '@/actions/quote'
import { useStreetDatasets, type DatasetLoader } from '@/components/address/StreetPicker'
import { PriceSummary } from '@/components/order/PriceSummary'
import { formatMoney, type Currency, type Locale } from '@/lib/money/format'
import { rolarPara } from '@/lib/motion/rolar'
import { TRIP_KINDS, type TripKind, type TripQuote } from '@/lib/pricing/trip'
import { GPS_MAX_FROM_STREET_M, MAX_ACCURACY_M, nearestByCountry, nearestStreet, PointPicker, type ChosenPlace } from './PointPicker'
import { REQUEST_COPY, failureText } from './copy'

type Props = {
  locale: Locale
  /** Moeda do total em destaque. Idioma e moeda são independentes (spec 11): um brasileiro pode ver em pesos. */
  currency: Currency
  /** Só para testes: de onde vêm os datasets de rua. Por padrão, import() dinâmico no primeiro foco. */
  loadDatasets?: DatasetLoader
}

type Step = 'from' | 'to'
type GpsNote = 'denied' | 'unavailable' | 'timeout' | 'ambiguous' | 'far' | null

const display = 'font-[family-name:var(--font-display)]'
/** A arte de cada serviço: o motoboy e a encomenda na garupa, na paleta pampa. */
const ICONE: Record<TripKind, string> = {
  ride: '/arte/icone-mototaxi-512.webp',
  courier: '/arte/icone-encomenda-512.webp',
}
const press = 'transition-transform active:scale-[0.985]'

export function RequestScreen({ locale, currency, loadDatasets }: Props) {
  const c = REQUEST_COPY[locale]
  const router = useRouter()
  const [kind, setKind] = useState<TripKind>('ride')
  const [from, setFrom] = useState<ChosenPlace | null>(null)
  const [to, setTo] = useState<ChosenPlace | null>(null)
  const [open, setOpen] = useState<Step | null>('from')

  // ROLAR SOZINHO CONFORME PREENCHE. Num celular o formulário é mais alto que a tela: escolher a origem abre o
  // destino ABAIXO DA DOBRA, e quem não rolou acha que o app travou. Então a tela leva a pessoa até o passo que
  // acabou de abrir, e até o preço quando as duas pontas estão de pé.
  //
  // Duas regras que isto respeita:
  //   - NÃO rola na montagem. A primeira coisa que se vê é a arte com o vídeo; pular isso seria roubar a entrada
  //     (por isso `primeiro`, e não um efeito solto em `open`);
  //   - com prefers-reduced-motion a rolagem é instantânea, não suave. Quem pediu menos movimento ainda precisa
  //     chegar lá — o que incomoda é o deslizar, não o destino.
  const passoRef = useRef<Record<Step, HTMLLIElement | null>>({ from: null, to: null })
  const precoRef = useRef<HTMLElement | null>(null)
  const primeiro = useRef(true)
  useEffect(() => {
    if (primeiro.current) {
      primeiro.current = false
      return
    }
    return rolarPara(open ? passoRef.current[open] : precoRef.current, open ? 'start' : 'center')
  }, [open])
  const [quote, setQuote] = useState<TripQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // O detalhe começa aberto: o preço é o motivo da visita, e a composição dele é o que faz confiar no número.
  const [detail, setDetail] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [gpsPending, setGpsPending] = useState(false)
  const [gpsNote, setGpsNote] = useState<GpsNote>(null)

  // Os datasets (225 kB + 401 kB) são carregados UMA vez, sob demanda, e servem às duas pontas e ao GPS.
  const { load, start } = useStreetDatasets(loadDatasets)
  const loadRef = useRef(load)
  loadRef.current = load

  const seq = useRef(0)
  const ready = from !== null && to !== null

  useEffect(() => {
    if (!from || !to) {
      seq.current++
      setQuote(null)
      setQuoting(false)
      setError(null)
      return
    }
    const mine = ++seq.current
    setQuoting(true)
    setError(null)
    void quoteTrip({ kind, pickup: from.point, dropoff: to.point })
      .then((res) => {
        if (mine !== seq.current) return // resposta velha não sobrescreve a nova
        if (res.ok) setQuote(res.quote)
        else {
          setQuote(null)
          setError(failureText(res.reason, locale))
        }
      })
      .catch(() => {
        if (mine === seq.current) setError(failureText('unknown', locale))
      })
      .finally(() => {
        if (mine === seq.current) setQuoting(false)
      })
  }, [kind, from, to, locale])

  const choose = (step: Step, place: ChosenPlace) => {
    if (step === 'from') setFrom(place)
    else setTo(place)
    setOpen(step === 'from' && to === null ? 'to' : null)
  }

  /** O estado de carga vive num hook; o GPS espera por ele sem virar um segundo carregador. */
  const waitForDatasets = async () => {
    for (let i = 0; i < 120; i++) {
      const l = loadRef.current
      if (l.state === 'ready') return l.datasets
      if (l.state === 'error') return null
      await new Promise((r) => setTimeout(r, 100))
    }
    return null
  }

  /** "Usar minha localização": o GPS dá a coordenada; as ruas dizem de que lado da ponte ela está. */
  const useGps = () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsNote('unavailable')
      return
    }
    setGpsNote(null)
    setGpsPending(true)
    start() // precisamos das ruas para saber a cidade, e é o mesmo dataset da busca
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const datasets = await waitForDatasets()
        setGpsPending(false)
        const point = { lat: pos.coords.latitude, lng: pos.coords.longitude }
        const near = datasets ? nearestStreet(point, datasets) : null
        if (!near || near.meters > GPS_MAX_FROM_STREET_M) {
          setGpsNote('far')
          return
        }

        // Um GPS impreciso não é inútil: é impreciso. O que o erro grande pode estragar não é o número da casa
        // (o dono confere a rua na tela) — é O LADO DO RIO, que decide moeda, travessia e preço. Então a
        // pergunta não é "quantos metros de erro", é "o outro país cabe dentro do círculo de erro?".
        const accuracy = pos.coords.accuracy
        const rough = accuracy > MAX_ACCURACY_M
        if (rough) {
          const byCountry = datasets ? nearestByCountry(point, datasets) : new Map()
          const other = [...byCountry.entries()].find(([country]) => country !== near.street.country)
          // O outro lado alcançável dentro do erro: a cidade não está decidida, e adivinhar cobra errado.
          if (other && other[1].meters <= accuracy) {
            setGpsNote('ambiguous')
            return
          }
        }

        setGpsNote(null)
        choose('from', {
          point: { city: near.street.city, country: near.street.country, ...point },
          label: c.gps_label,
          // Com erro grande a rua é um palpite bom, não um fato: a linha de baixo diz isso, e fica na tela.
          detail: rough ? c.gps_near_rough(near.street.name) : c.gps_near(near.street.name),
        })
      },
      (err) => {
        setGpsPending(false)
        setGpsNote(err.code === err.PERMISSION_DENIED ? 'denied' : err.code === err.TIMEOUT ? 'timeout' : 'unavailable')
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    )
  }

  const stepLabel = (step: Step) =>
    step === 'from' ? (kind === 'ride' ? c.from_ride : c.from_courier) : kind === 'ride' ? c.to_ride : c.to_courier

  // Distância com vírgula decimal: é assim que se escreve nos dois idiomas da fronteira.
  const km = useMemo(() => (quote ? (quote.distanceM / 1000).toFixed(1).replace('.', ',') : ''), [quote])

  const confirm = async () => {
    if (!quote || quote.blocked || confirming) return
    setConfirming(true)
    try {
      router.push(await requestNextPath(kind))
    } catch {
      setConfirming(false)
      setError(failureText('unknown', locale))
    }
  }

  const totalCurrency: Currency = currency === 'UYU' && quote?.totalUyu != null ? 'UYU' : 'BRL'
  const total = quote ? (totalCurrency === 'UYU' ? quote.totalUyu! : quote.totalBrl) : 0
  const second =
    quote && quote.totalUyu !== null
      ? totalCurrency === 'BRL'
        ? formatMoney(quote.totalUyu, 'UYU', locale)
        : formatMoney(quote.totalBrl, 'BRL', locale)
      : null

  // Barra de passos em guarda pampa: 1 de onde, 2 para onde, 3 preço. Estrutura, não adesivo.
  const done = (from ? 1 : 0) + (to ? 1 : 0) + (quote && !quote.blocked ? 1 : 0)

  return (
    // `flex-col` e não `grid`: item de grid nasce com min-width auto, e aí uma palavra comprida
    // (um nome de rua uruguaio) estica a coluna e vaza a tela de 360 px em vez de ser cortada.
    <div className="flex flex-col gap-4">
      <div className="passo-barra grid grid-cols-3 gap-1.5" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="relative h-3 overflow-hidden">
            {/* trilho apagado, trecho cumprido em sol, e o passo da vez meio aceso: dá para ver onde se está */}
            <div className={`guarda-pampa h-3 ${i === done ? 'text-sol/35' : 'text-white/12'}`} />
            <span
              className="guarda-pampa absolute inset-0 h-3 text-sol"
              style={{ transform: `scaleX(${i < done ? 1 : 0})` }}
            />
          </div>
        ))}
      </div>

      {/* Serviço. Dois, e só dois: comida o cliente pede na loja, e a loja chama o motoboy na tela dela.
          São os dois alvos grandes do topo, com a arte de cada um — é a primeira coisa que a pessoa vê. */}
      <div role="tablist" aria-label={c.headline} className="grid grid-cols-2 gap-2">
        {TRIP_KINDS.map((k) => {
          const on = k === kind
          return (
            <button
              key={k}
              role="tab"
              type="button"
              aria-selected={on}
              onClick={() => setKind(k)}
              className={`${press} grid min-w-0 content-start justify-items-center gap-1 rounded-xl border px-2 pb-3 pt-2 text-center ${
                on ? 'border-sol bg-sol/15' : 'border-white/15 bg-white/[0.03]'
              }`}
            >
              <Image
                src={ICONE[k]}
                alt=""
                width={256}
                height={256}
                sizes="88px"
                className={`size-[72px] rounded-lg transition-opacity ${on ? 'opacity-100' : 'opacity-70'}`}
              />
              <span className={`${display} truncate text-xl font-extrabold uppercase leading-none ${on ? 'text-sol' : 'text-white'}`}>
                {c[`kind_${k}`]}
              </span>
              <span className="truncate text-xs text-white/60">{c[`kind_${k}_hint`]}</span>
            </button>
          )
        })}
      </div>

      {/* As duas pontas. Fechadas, um resumo de uma linha; abertas, o seletor de endereço inteiro.
          O trilho da esquerda liga as duas: é um caminho, não dois blocos empilhados. */}
      <ol className="relative flex flex-col gap-2">
        <span aria-hidden="true" className="absolute bottom-8 left-[7px] top-8 w-px bg-white/10" />
        {(['from', 'to'] as const).map((step, i) => {
          const place = step === 'from' ? from : to
          const isOpen = open === step
          return (
            <li
              key={step}
              ref={(el) => {
                passoRef.current[step] = el
              }}
              className="relative min-w-0 scroll-mt-4"
            >
              <span
                aria-hidden="true"
                className={`absolute left-0 top-7 z-10 size-3.5 rounded-full border-2 ${
                  place ? 'border-sol bg-sol' : 'border-white/30 bg-noite'
                } ${step === 'to' ? 'rounded-sm' : ''}`}
              />
              <div className={`ml-6 min-w-0 rounded-xl border bg-white/[0.04] ${isOpen ? 'border-sol/50' : 'border-white/12'}`}>
                {isOpen ? (
                  <div className="passo-entra grid gap-4 p-4">
                    <div>
                      <p className="text-xs uppercase tracking-widest text-white/50">{c.step(i + 1)}</p>
                      <h2 className={`${display} text-2xl font-extrabold uppercase leading-none`}>{stepLabel(step)}</h2>
                    </div>
                    <PointPicker
                      locale={locale}
                      load={load}
                      onStart={start}
                      onChoose={(p) => choose(step, p)}
                      gps={
                        step === 'from'
                          ? { pending: gpsPending, note: gpsNote ? c[`gps_${gpsNote}`] : null, onUse: useGps }
                          : null
                      }
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setOpen(step)}
                    className={`${press} flex min-h-16 w-full items-center gap-3 p-4 text-left`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs uppercase tracking-widest text-white/50">{stepLabel(step)}</span>
                      {place ? (
                        <>
                          <span className="block truncate text-base font-semibold text-white">{place.label}</span>
                          <span className="block truncate text-sm text-white/60">{place.detail}</span>
                        </>
                      ) : (
                        <span className="block text-base text-white/50">{step === 'from' ? c.empty_from : c.empty_to}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-sm font-semibold text-sol" aria-hidden="true">
                      {place ? c.change : '+'}
                    </span>
                  </button>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {/* O PREÇO. É o motivo de alguém abrir isto: fica colado na borda de baixo, é o que tem mais contraste
          na tela e entra com peso. Antes de existir, o lugar dele já está reservado e explicado — tela vazia
          que não explica nada parece app quebrado. */}
      <section
        ref={precoRef}
        aria-live="polite"
        className={`-mx-4 min-w-0 border-t border-white/12 bg-noite/95 px-4 pb-5 pt-4 supports-[backdrop-filter]:bg-noite/80 supports-[backdrop-filter]:backdrop-blur-sm ${
          // vazio ele não gruda: num celular de 740 px, roubar 250 px do formulário para mostrar um traço
          // é pior do que esperar o preço existir.
          quote || quoting || error ? 'sticky bottom-0 z-20' : ''
        }`}
      >
        <div aria-hidden="true" className="guarda-pampa mb-3 h-2 text-sol/60" />

        {!ready && !quoting && !error && (
          <div className="grid gap-1">
            <p className="text-xs uppercase tracking-widest text-white/50">{c.price_title}</p>
            <p className={`preco ${display} text-[clamp(2.25rem,12vw,3rem)] font-extrabold leading-none text-white/15`}>
              {`${formatMoney(0, 'BRL', locale).split(' ')[0]} ——`}
            </p>
            <p className="text-sm text-white/55">{c.price_empty}</p>
          </div>
        )}

        {quoting && !quote && (
          <p className="min-h-16 text-base text-white/70" role="status">
            {c.quoting}
          </p>
        )}

        {error && !quoting && (
          <p role="alert" className="rounded-lg border border-brasa/60 bg-brasa/15 px-3 py-2 text-sm text-white">
            {error}
          </p>
        )}

        {quote && !quote.blocked && (
          <>
            <div key={`${total}-${totalCurrency}`} className="valor-entra flex items-end justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-widest text-white/50">{c.price_title}</p>
                <p className={`preco ${display} text-[clamp(2.5rem,13vw,3.5rem)] font-extrabold leading-none text-sol`}>
                  {formatMoney(total, totalCurrency, locale)}
                </p>
              </div>
              {second && <p className="preco pb-1.5 text-right text-base text-white/60">{second}</p>}
            </div>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-white/60">
              <span>{quote.routeSource === 'osrm' ? c.distance(km) : c.distance_estimated(km)}</span>
              {quote.crossesBorder && (
                <>
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-rio" />
                  <span className="text-rio">{c.crosses}</span>
                </>
              )}
            </p>
            <button
              type="button"
              onClick={() => setDetail((d) => !d)}
              aria-expanded={detail}
              className="mt-1 min-h-11 text-sm font-semibold text-white/75 underline decoration-white/25 underline-offset-4"
            >
              {detail ? c.detail_close : c.detail_open}
            </button>
            {detail && (
              <div key={`detalhe-${total}`} className="desdobra mt-1">
                <PriceSummary quote={quote} currency={currency} locale={locale} />
              </div>
            )}
          </>
        )}

        {quote?.blocked && <PriceSummary quote={quote} currency={currency} locale={locale} />}

        <button
          type="button"
          onClick={confirm}
          disabled={!quote || quote.blocked || quoting || confirming}
          className={`${press} mt-3 min-h-12 w-full rounded-lg bg-sol text-base font-bold text-noite disabled:opacity-25`}
        >
          {confirming ? c.confirming : kind === 'ride' ? c.confirm_ride : c.confirm_courier}
        </button>
      </section>
    </div>
  )
}
