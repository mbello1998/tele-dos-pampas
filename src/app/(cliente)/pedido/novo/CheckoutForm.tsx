'use client'

// Confirmação do pedido. A tela mostra o preço que o SERVIDOR cotou (quoteOrder) e manda de volta o total que viu;
// o servidor recota e recusa se divergir. Nada aqui calcula preço: a tela só dá a intenção (tipo e endereços).
// Serve a mototáxi e encomenda, que quem pede é o cliente. A entrega da loja (`delivery`) tem tela própria.
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { createOrder, quoteOrder } from '@/actions/orders'
import { errorClass, inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from '@/components/auth/ui'
import { PriceSummary } from '@/components/order/PriceSummary'
import type { Locale } from '@/lib/i18n'
import { formatMoney, type Currency } from '@/lib/money/format'
import { copyT } from './copy'
import { CUSTOMER_KINDS, type CustomerQuote, type OrderKind, type PaymentMethod } from './order-core'

export type CheckoutAddress = { id: string; label: string; summary: string }

type Props = {
  kind: OrderKind
  locale: Locale
  currencyPref: Currency
  addresses: CheckoutAddress[]
}

const KINDS: OrderKind[] = [...CUSTOMER_KINDS]
const IDS = { dropoff: 'co-dropoff', pickup: 'co-pickup', change: 'co-change', notes: 'co-notes' }

export function CheckoutForm({ kind, locale, currencyPref, addresses }: Props) {
  const router = useRouter()
  const t = (key: string) => copyT(key, locale)

  const [dropoffId, setDropoffId] = useState(addresses[0]?.id ?? '')
  const [pickupId, setPickupId] = useState(addresses[0]?.id ?? '')
  const [payment, setPayment] = useState<PaymentMethod>(currencyPref === 'UYU' ? 'dinheiro_uyu' : 'pix')
  const [changeText, setChangeText] = useState('')
  const [notes, setNotes] = useState('')
  const [quote, setQuote] = useState<CustomerQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // Guarda síncrona, como a do formulário de endereço: o estado só muda no próximo render, e dois toques seguidos
  // numa conexão lenta chegam antes dele. O banco também recusa um segundo pedido idêntico (TD011).
  const inFlight = useRef(false)

  const ready = Boolean(dropoffId) && Boolean(pickupId)

  // A intenção que vai ao servidor. Só ids: nenhum preço, distância ou coordenada.
  const intent = useMemo(
    () => ({ kind, merchantId: null, items: [], pickupAddressId: pickupId, dropoffAddressId: dropoffId }),
    [kind, pickupId, dropoffId],
  )

  const seq = useRef(0)
  const requestQuote = async () => {
    const mine = ++seq.current
    setQuoting(true)
    setQuote(null)
    try {
      const res = await quoteOrder(intent)
      if (mine !== seq.current) return // uma resposta antiga não sobrescreve a mais nova
      if (res.ok) {
        setQuote(res.quote)
        setError(null)
      } else {
        setError(res.message)
      }
    } catch {
      if (mine === seq.current) setError(t('quote_failed'))
    } finally {
      if (mine === seq.current) setQuoting(false)
    }
  }

  useEffect(() => {
    if (!ready) {
      seq.current++
      setQuote(null)
      setQuoting(false)
      return
    }
    void requestQuote()
    // requestQuote lê `intent`, que já é a dependência
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, intent])

  const cash = payment !== 'pix'
  const chargedCurrency: Currency = payment === 'dinheiro_uyu' ? 'UYU' : 'BRL'
  const charged = quote ? (chargedCurrency === 'UYU' ? quote.totalUyu : quote.totalBrl) : null
  // vírgula decimal de quem digita em pt-BR e es-UY
  const changeValue = changeText.trim() === '' ? null : Number(changeText.trim().replace(',', '.'))
  const changeInvalid = changeValue !== null && (!Number.isFinite(changeValue) || changeValue <= 0)
  const changeMissing = payment === 'dinheiro_uyu' && changeValue === null
  const noPesos = payment === 'dinheiro_uyu' && quote?.totalUyu == null

  const canSubmit = Boolean(quote) && !quote?.blocked && !quoting && !submitting && !changeInvalid && !changeMissing && !noPesos

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (inFlight.current || !canSubmit || !quote) return
    inFlight.current = true
    setSubmitting(true)
    setError(null)
    setNotice(null)
    try {
      const res = await createOrder({
        ...intent,
        paymentMethod: payment,
        changeFor: cash ? changeValue : null,
        clientTotalBrl: quote.totalBrl,
        clientTotalUyu: quote.totalUyu,
        notes: notes.trim() === '' ? null : notes.trim(),
      })
      if (res.ok) {
        router.push(`/pedido/${res.code}`)
        return // o botão fica desativado até a navegação: um segundo toque não cria um segundo pedido
      }
      if (res.reason === 'price_changed') {
        setNotice(t('price_updated'))
        void requestQuote()
      } else {
        setError(res.message)
      }
    } catch {
      setError(t('quote_failed'))
    }
    inFlight.current = false
    setSubmitting(false)
  }

  const addressSelect = (id: string, label: string, value: string, set: (v: string) => void) => (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => set(e.target.value)} className={inputClass}>
        {addresses.map((a) => (
          <option key={a.id} value={a.id}>
            {a.summary ? `${a.label} — ${a.summary}` : a.label}
          </option>
        ))}
      </select>
    </div>
  )

  return (
    <form onSubmit={submit} noValidate lang={locale} className="space-y-5" data-testid="checkout-form" aria-busy={submitting}>
      <nav aria-label={t('title')} className="flex gap-2">
        {KINDS.map((k) => (
          <Link
            key={k}
            href={`/pedido/novo?kind=${k}`}
            aria-current={k === kind ? 'page' : undefined}
            className={`${k === kind ? 'bg-sol text-noite' : 'border border-white/25 text-white/90'} inline-flex min-h-11 flex-1 items-center justify-center rounded-lg px-3 text-sm font-semibold`}
          >
            {t(`kind_${k}`)}
          </Link>
        ))}
      </nav>

      {addresses.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <p className="text-white/80">{t('no_addresses')}</p>
          <Link href="/enderecos/novo" className={`${secondaryButtonClass} mt-3`}>
            {t('new_address')}
          </Link>
        </div>
      ) : (
        <>
          {addressSelect(IDS.pickup, kind === 'ride' ? t('ride_pickup') : t('pickup'), pickupId, setPickupId)}
          {addressSelect(IDS.dropoff, kind === 'ride' ? t('ride_dropoff') : t('dropoff'), dropoffId, setDropoffId)}
          <Link href="/enderecos/novo" className="inline-block min-h-11 text-sm text-white/70 underline">
            {t('new_address')}
          </Link>
        </>
      )}

      {quoting && (
        <p role="status" className="text-white/70">
          {t('quoting')}
        </p>
      )}
      {quote && <PriceSummary quote={quote} currency={currencyPref} locale={locale} />}

      <fieldset>
        <legend className={labelClass}>{t('payment')}</legend>
        <div className="grid gap-2">
          {(['pix', 'dinheiro_brl', 'dinheiro_uyu'] as const).map((m) => (
            <label key={m} className="flex min-h-11 items-center gap-3 rounded-lg border border-white/20 px-3 py-2">
              <input type="radio" name="payment" value={m} checked={payment === m} onChange={() => setPayment(m)} />
              <span>{t(`pay_${m}`)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {cash && (
        <div>
          <label htmlFor={IDS.change} className={labelClass}>
            {t(payment === 'dinheiro_uyu' ? 'change_for_uyu' : 'change_for_brl')}
          </label>
          <input
            id={IDS.change}
            inputMode="decimal"
            value={changeText}
            onChange={(e) => setChangeText(e.target.value)}
            aria-describedby={`${IDS.change}-hint`}
            aria-invalid={changeInvalid || undefined}
            className={`${inputClass} preco`}
          />
          <p id={`${IDS.change}-hint`} className="mt-1.5 text-sm text-white/55">
            {t('change_hint')}
            {charged !== null && ` (${formatMoney(charged, chargedCurrency, locale)})`}
          </p>
        </div>
      )}

      <div>
        <label htmlFor={IDS.notes} className={labelClass}>
          {t('notes')}
        </label>
        <textarea id={IDS.notes} value={notes} maxLength={500} rows={2} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
      </div>

      {notice && (
        <p role="status" className="rounded-lg border border-rio/60 bg-rio/15 px-3 py-2 text-sm text-white">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className={errorClass}>
          {error}
        </p>
      )}

      <button type="submit" disabled={!canSubmit} className={primaryButtonClass} data-testid="confirm-order">
        {submitting ? t('confirming') : t('confirm')}
      </button>
    </form>
  )
}
