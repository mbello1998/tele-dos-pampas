'use client'

// A TELA DA LOJA: chamar um motoboy. A loja já vendeu o lanche pelo WhatsApp; aqui ela só diz para onde vai a
// sacola. Quatro perguntas, nesta ordem, e o preço:
//   1. o endereço do comprador (o seletor de endereço que já existe: 512 ruas, quadra, pino, referência);
//   2. o que vai na sacola (texto livre);
//   3. quanto o motoboy cobra do comprador (opcional; em reais ou em pesos, com troco);
//   4. quem paga a entrega (a loja ou o comprador, por pedido).
//
// O PREÇO DA ENTREGA NÃO É DIGITADO NEM EDITÁVEL. Ele sai de quoteShopDelivery, que pede ao banco a conta na
// TARIFA DE QUEM PAGA (public.quote_order): convênio quando a loja paga, balcão quando o comprador paga. Esta tela só formata (formatMoney) e alinha (.preco). A única conta
// feita aqui é a que o motoboy leva do comprador e o troco, e é só para mostrar: create_order a refaz no banco.
//
// Movimento: só CSS (src/styles/motion.css), sem GSAP, como a tela de pedir corrida.
import { useEffect, useMemo, useRef, useState } from 'react'
import { createShopDelivery, quoteShopDelivery } from '@/actions/shop-delivery'
import type { Address } from '@/actions/addresses'
import { AddressForm } from '@/components/address/AddressForm'
import { PriceSummary } from '@/components/order/PriceSummary'
import { FAILURE_COPY, type CustomerQuote } from '@/app/(cliente)/pedido/novo/order-core'
import { formatMoney, type Currency, type Locale } from '@/lib/money/format'
import { collectView, MAX_COLLECT_BRL, MAX_LOAD, type FeePayer, type PayCurrency } from '@/lib/pricing/shop'
import { SHOP_COPY } from './copy'

export type ShopOption = { id: string; name: string }
export type SavedAddress = { id: string; label: string; summary: string }

type Props = {
  locale: Locale
  /** Moeda do total em destaque (preferência do dono). */
  currency: Currency
  shops: ShopOption[]
  saved: SavedAddress[]
}

const display = 'font-[family-name:var(--font-display)]'
const press = 'transition-transform active:scale-[0.985]'
const field =
  'min-h-12 w-full rounded-lg border border-borda bg-poco px-3 text-base text-white placeholder:text-white/35 transition-colors focus:border-rio focus:outline-none focus:ring-2 focus:ring-rio/50'

/** "45,50", "45.5", "R$ 45" -> 45.5. Vazio -> null. Lixo -> 'invalid'. Sem separador de milhar: ninguém vende lanche a R$ 1.000. */
function parseMoney(text: string): number | null | 'invalid' {
  const t = text.replace(/R\$|\$U|\s/g, '').replace(',', '.')
  if (t === '') return null
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(t)) return 'invalid'
  const n = Number(t)
  return n > MAX_COLLECT_BRL ? 'invalid' : n
}

export function ShopDeliveryScreen({ locale, currency, shops, saved: initialSaved }: Props) {
  const c = SHOP_COPY[locale]
  const [shopId, setShopId] = useState(shops[0].id)
  const [saved, setSaved] = useState(initialSaved)
  const [address, setAddress] = useState<SavedAddress | null>(null)
  // aberto no começo: o endereço é a primeira pergunta. Sem endereço salvo, já mostra o formulário.
  const [pickerOpen, setPickerOpen] = useState(true)
  const [creating, setCreating] = useState(initialSaved.length === 0)
  const [load, setLoad] = useState('')
  const [collectText, setCollectText] = useState('')
  const [payCurrency, setPayCurrency] = useState<PayCurrency>('BRL')
  const [noteText, setNoteText] = useState('')
  const [feePayer, setFeePayer] = useState<FeePayer>('merchant')

  const [quote, setQuote] = useState<CustomerQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState(false)
  const [tried, setTried] = useState(false)
  const [sending, setSending] = useState(false)
  const [done, setDone] = useState<{ code: string; duplicate: boolean } | null>(null)
  // Guarda síncrona: o estado só muda no próximo render, e dois toques seguidos chegam antes dele.
  const inFlight = useRef(false)
  const seq = useRef(0)

  // O preço aparece sozinho quando o endereço existe: ninguém aperta "calcular".
  useEffect(() => {
    if (!address) {
      seq.current++
      setQuote(null)
      setQuoting(false)
      setError(null)
      return
    }
    const mine = ++seq.current
    setQuoting(true)
    setError(null)
    void quoteShopDelivery({ merchantId: shopId, dropoffAddressId: address.id, feePayer })
      .then((res) => {
        if (mine !== seq.current) return // resposta velha não sobrescreve a nova
        if (res.ok) setQuote(res.quote)
        else {
          setQuote(null)
          setError(res.message)
        }
      })
      .catch(() => {
        if (mine === seq.current) setError(FAILURE_COPY.unknown[locale])
      })
      .finally(() => {
        if (mine === seq.current) setQuoting(false)
      })
    // feePayer está aqui porque MUDA O PREÇO: trocar quem paga troca a tarifa, e a tela tem de recotar.
  }, [address, shopId, locale, feePayer])

  const collect = parseMoney(collectText)
  const note = parseMoney(noteText)
  const collectBrl = typeof collect === 'number' ? collect : 0
  const hasCollect = collectBrl > 0
  const fee = quote && !quote.blocked ? quote.totalBrl : null

  // O que o motoboy leva do comprador e o troco: só para mostrar (o banco refaz a conta).
  const view = useMemo(
    () =>
      fee !== null
        ? collectView({
            collectBrl,
            feeBrl: fee,
            feePayer,
            currency: payCurrency,
            rateUsed: quote?.fxRateUsed ?? null,
            changeFor: typeof note === 'number' && note > 0 ? note : null,
          })
        : null,
    [fee, collectBrl, feePayer, payCurrency, quote?.fxRateUsed, note],
  )
  const owesAnything = view !== null && view.owedBrl > 0
  const noteTooShort = view !== null && view.owed !== null && typeof note === 'number' && note > 0 && note < view.owed

  const km = quote ? (quote.distanceM / 1000).toFixed(1).replace('.', ',') : ''
  const totalCurrency: Currency = currency === 'UYU' && quote?.totalUyu != null ? 'UYU' : 'BRL'
  const total = quote ? (totalCurrency === 'UYU' ? quote.totalUyu! : quote.totalBrl) : 0
  const second =
    quote && quote.totalUyu !== null
      ? totalCurrency === 'BRL'
        ? formatMoney(quote.totalUyu, 'UYU', locale)
        : formatMoney(quote.totalBrl, 'BRL', locale)
      : null

  const missingLoad = load.trim() === ''
  const canSend = !!address && !!quote && !quote.blocked && !missingLoad && collect !== 'invalid' && note !== 'invalid' && !noteTooShort

  const pick = (a: SavedAddress) => {
    setAddress(a)
    setPickerOpen(false)
    setCreating(false)
  }
  const onCreated = (a: Address) => {
    const s: SavedAddress = { id: a.id, label: a.label, summary: [a.streetName, a.number].filter(Boolean).join(', ') }
    setSaved((list) => [s, ...list])
    pick(s)
  }

  const send = async () => {
    setTried(true)
    if (!canSend || inFlight.current || !quote) return
    inFlight.current = true
    setSending(true)
    setError(null)
    try {
      const res = await createShopDelivery({
        merchantId: shopId,
        dropoffAddressId: address!.id,
        loadDescription: load.trim(),
        collectAmountBrl: hasCollect ? collectBrl : null,
        feePayer,
        payCurrency,
        changeFor: typeof note === 'number' && note > 0 ? note : null,
        clientTotalBrl: quote.totalBrl, // só para o servidor comparar: o preço é dele
      })
      if (res.ok) setDone({ code: res.code, duplicate: res.duplicate === true })
      else {
        setError(res.message)
        // o preço mudou desde que o dono viu: mostra o novo antes de qualquer outro toque
        if (res.reason === 'price_changed') {
          const again = await quoteShopDelivery({ merchantId: shopId, dropoffAddressId: address!.id })
          if (again.ok) setQuote(again.quote)
        }
      }
    } catch {
      setError(FAILURE_COPY.unknown[locale])
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }

  const reset = () => {
    setDone(null)
    setAddress(null)
    setPickerOpen(true)
    setCreating(saved.length === 0)
    setLoad('')
    setCollectText('')
    setNoteText('')
    setPayCurrency('BRL')
    setFeePayer('merchant')
    setTried(false)
    setError(null)
  }

  if (done) {
    return (
      <section role="status" className="valor-entra grid gap-3 rounded-xl border border-sol/60 bg-sol/10 p-5">
        <div aria-hidden="true" className="guarda-pampa h-2 text-sol/60" />
        <h2 className={`${display} text-4xl font-extrabold uppercase leading-none text-sol`}>{c.done_title}</h2>
        <div>
          <p className="text-xs uppercase tracking-widest text-white/50">{c.done_code}</p>
          <p className={`preco ${display} text-5xl font-extrabold leading-none tracking-wider`}>{done.code}</p>
        </div>
        {done.duplicate && <p className="text-sm text-white/70">{c.done_duplicate}</p>}
        <button type="button" onClick={reset} className={`${press} mt-2 min-h-12 w-full rounded-lg bg-sol text-base font-bold text-noite`}>
          {c.done_again}
        </button>
      </section>
    )
  }

  const stepHead = (n: number, title: string, optional?: string) => (
    <div>
      <p className="text-xs uppercase tracking-widest text-white/50">{c.step(n)}</p>
      <h2 className={`${display} text-2xl font-extrabold uppercase leading-none`}>
        {title}
        {optional && <span className="ml-2 align-middle text-sm font-semibold normal-case tracking-normal text-white/45">{optional}</span>}
      </h2>
    </div>
  )
  const card = 'min-w-0 rounded-xl border bg-superficie p-4'

  return (
    <div className="flex flex-col gap-4">
      {shops.length > 1 && (
        <label className="grid gap-1 text-sm text-white/60">
          {c.shop}
          <select value={shopId} onChange={(e) => setShopId(e.target.value)} className={`${field} appearance-none bg-noite pr-9 [&>option]:bg-noite [&>option]:text-white`}>
            {shops.map((s) => (
              <option key={s.id} value={s.id} className="bg-noite">
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* 1. O endereço do comprador */}
      <section className={`${card} ${pickerOpen ? 'border-sol/50' : 'border-borda'}`}>
        {pickerOpen ? (
          <div className="passo-entra grid gap-4">
            {stepHead(1, c.address_title)}
            {creating ? (
              <>
                <AddressForm onDone={onCreated} locale={locale} />
                {saved.length > 0 && (
                  <button type="button" onClick={() => setCreating(false)} className="min-h-11 text-left text-sm font-semibold text-sol underline underline-offset-4">
                    {c.address_back}
                  </button>
                )}
              </>
            ) : (
              <>
                <p className="text-sm text-white/55">{c.address_saved}</p>
                <ul className="grid gap-2">
                  {saved.map((a) => (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => pick(a)}
                        className={`${press} grid min-h-14 w-full min-w-0 content-center rounded-lg border border-borda bg-white/[0.03] px-3 py-2 text-left`}
                      >
                        <span className="truncate text-base font-semibold">{a.label}</span>
                        {a.summary && a.summary !== a.label && <span className="truncate text-sm text-white/60">{a.summary}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className={`${press} min-h-12 rounded-lg border border-sol/60 text-base font-bold text-sol`}
                >
                  + {c.address_new}
                </button>
              </>
            )}
          </div>
        ) : (
          <button type="button" onClick={() => setPickerOpen(true)} className={`${press} flex min-h-12 w-full items-center gap-3 text-left`}>
            <span className="min-w-0 flex-1">
              <span className="block text-xs uppercase tracking-widest text-white/50">{c.address_title}</span>
              {address ? (
                <>
                  <span className="block truncate text-base font-semibold text-white">{address.label}</span>
                  {address.summary && address.summary !== address.label && (
                    <span className="block truncate text-sm text-white/60">{address.summary}</span>
                  )}
                </>
              ) : (
                <span className="block text-base text-white/50">{c.address_empty}</span>
              )}
            </span>
            <span className="shrink-0 text-sm font-semibold text-sol">{c.address_change}</span>
          </button>
        )}
      </section>

      {/* 2. O que vai na sacola */}
      <section className={`${card} grid gap-3 border-borda`}>
        {stepHead(2, c.load_title)}
        <label className="grid gap-1">
          <span className="sr-only">{c.load_title}</span>
          <textarea
            value={load}
            onChange={(e) => setLoad(e.target.value)}
            maxLength={MAX_LOAD}
            rows={3}
            placeholder={c.load_placeholder}
            aria-invalid={tried && missingLoad}
            className={`${field} resize-none py-3`}
          />
        </label>
        <p className={`text-sm ${tried && missingLoad ? 'text-brasa' : 'text-white/55'}`}>{tried && missingLoad ? c.need_load : c.load_help}</p>
      </section>

      {/* 3. Quanto o motoboy cobra do comprador */}
      <section className={`${card} grid gap-3 border-borda`}>
        {stepHead(3, c.collect_title, c.collect_optional)}
        <label className="grid gap-1">
          <span className="sr-only">{c.collect_title}</span>
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-white/60" aria-hidden="true">
              R$
            </span>
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={collectText}
              onChange={(e) => setCollectText(e.target.value)}
              placeholder="45,50"
              aria-invalid={collect === 'invalid'}
              className={`preco ${field}`}
            />
          </div>
        </label>
        <p className={`text-sm ${collect === 'invalid' ? 'text-brasa' : 'text-white/55'}`}>
          {collect === 'invalid' ? c.collect_invalid : c.collect_help}
        </p>

        {hasCollect && (
          <div className="desdobra grid gap-3 border-t border-borda pt-3">
            <div role="group" aria-label={c.collect_in} className="grid gap-1.5">
              <p className="text-xs uppercase tracking-widest text-white/50">{c.collect_in}</p>
              <div className="grid grid-cols-2 gap-2">
                {(['BRL', 'UYU'] as const).map((cur) => (
                  <button
                    key={cur}
                    type="button"
                    aria-pressed={payCurrency === cur}
                    onClick={() => setPayCurrency(cur)}
                    className={`${press} min-h-12 rounded-lg border text-base font-bold ${
                      payCurrency === cur ? 'border-sol bg-sol/15 text-sol' : 'border-borda text-white/80'
                    }`}
                  >
                    {cur === 'BRL' ? c.reais : c.pesos}
                  </button>
                ))}
              </div>
            </div>

            {view && view.owed !== null ? (
              <div className="flex items-end justify-between gap-3 rounded-lg bg-superficie px-3 py-3">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-widest text-white/50">{c.collect_total}</p>
                  {feePayer === 'client' && <p className="text-xs text-white/45">{c.collect_includes_fee}</p>}
                </div>
                <p className={`preco ${display} shrink-0 text-3xl font-extrabold leading-none text-white`}>
                  {formatMoney(view.owed, payCurrency, locale)}
                </p>
              </div>
            ) : (
              <p className="text-sm text-white/55">{c.collect_needs_address}</p>
            )}
            {view && view.owed !== null && payCurrency === 'UYU' && (
              <p className="preco text-sm text-white/55">≈ {formatMoney(view.owedBrl, 'BRL', locale)}</p>
            )}

            {view && view.owed !== null && owesAnything && (
              <label className="grid gap-1">
                <span className="text-xs uppercase tracking-widest text-white/50">
                  {c.note_title} ({payCurrency === 'BRL' ? 'R$' : '$U'})
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder={payCurrency === 'BRL' ? '100' : '500'}
                  aria-invalid={note === 'invalid' || noteTooShort}
                  className={`preco ${field}`}
                />
                <span className={`text-sm ${noteTooShort || note === 'invalid' ? 'text-brasa' : 'text-white/55'}`}>
                  {noteTooShort ? (
                    c.note_short
                  ) : view.change !== null ? (
                    <>
                      {c.change}: <span className="preco font-semibold text-white">{formatMoney(view.change, payCurrency, locale)}</span>
                    </>
                  ) : note === 'invalid' ? (
                    c.collect_invalid
                  ) : (
                    c.note_help
                  )}
                </span>
              </label>
            )}
          </div>
        )}
      </section>

      {/* 4. Quem paga a entrega */}
      <section className={`${card} grid gap-3 border-borda`}>
        {stepHead(4, c.payer_title)}
        <div role="radiogroup" aria-label={c.payer_title} className="grid grid-cols-2 gap-2">
          {(['merchant', 'client'] as const).map((p) => {
            const on = feePayer === p
            return (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setFeePayer(p)}
                className={`${press} grid min-w-0 content-start gap-0.5 rounded-lg border px-3 py-3 text-left ${
                  on ? 'border-sol bg-sol/15' : 'border-borda bg-white/[0.03]'
                }`}
              >
                <span className={`${display} text-xl font-extrabold uppercase leading-none ${on ? 'text-sol' : 'text-white'}`}>
                  {p === 'merchant' ? c.payer_merchant : c.payer_client}
                </span>
                <span className="text-xs text-white/60">{p === 'merchant' ? c.payer_merchant_hint : c.payer_client_hint}</span>
              </button>
            )
          })}
        </div>
      </section>

      {/* O PREÇO. Calculado pela plataforma: não há campo para digitá-lo. Cola na borda de baixo quando existe. */}
      <section
        aria-live="polite"
        className={`-mx-4 min-w-0 border-t border-borda bg-noite/95 px-4 pb-5 pt-4 supports-[backdrop-filter]:bg-noite/80 supports-[backdrop-filter]:backdrop-blur-sm ${
          quote || quoting || error ? 'sticky bottom-0 z-20' : ''
        }`}
      >
        <div aria-hidden="true" className="guarda-pampa mb-3 h-2 text-sol/60" />

        {!address && !quoting && !error && (
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
            <p className="mt-1 text-sm text-white/55">{c.agreement}</p>
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

        {tried && !address && <p className="mt-2 text-sm text-brasa">{c.need_address}</p>}
        <button
          type="button"
          onClick={send}
          disabled={quoting || sending || (!!quote && quote.blocked)}
          className={`${press} mt-3 min-h-12 w-full rounded-lg bg-sol text-base font-bold text-noite disabled:opacity-25`}
        >
          {sending ? c.confirming : c.confirm}
        </button>
      </section>
    </div>
  )
}
