'use client'

// Confirmação do pedido. A tela mostra o preço que o SERVIDOR cotou (quoteOrder) e manda de volta o total que viu;
// o servidor recota e recusa se divergir. Nada aqui calcula preço: a tela só dá a intenção (tipo e endereços).
// Serve a mototáxi e encomenda, que quem pede é o cliente. A entrega da loja (`delivery`) tem tela própria.
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { saveAddress, type AddressInput } from '@/actions/addresses'
import { createOrder, quoteOrder } from '@/actions/orders'
import { errorClass, inputClass, labelClass, primaryButtonClass, secondaryButtonClass, selectClass } from '@/components/auth/ui'
import { PriceSummary } from '@/components/order/PriceSummary'
import type { Locale } from '@/lib/i18n'
import { formatMoney, type Currency } from '@/lib/money/format'
import { takeTrip } from '@/lib/trip/handoff'
import { copyT } from './copy'
import { CUSTOMER_KINDS, type CustomerQuote, type OrderKind, type PaymentMethod } from './order-core'

export type CheckoutAddress = { id: string; label: string; summary: string }

type Props = {
  kind: OrderKind
  locale: Locale
  currencyPref: Currency
  addresses: CheckoutAddress[]
}

const KINDS = [...CUSTOMER_KINDS] as OrderKind[]
const IDS = { dropoff: 'co-dropoff', pickup: 'co-pickup', change: 'co-change', notes: 'co-notes' }

/**
 * Endereço salvo EXIGE ponto de referência (saveAddress), e com razão: sem ele o motoboy chega na quadra certa
 * e não acha a porta. Mas a tela de pedido deixa a referência em branco quando a quadra é conhecida, porque o
 * PREÇO não precisa dela. Quando o trajeto atravessa, a quadra escolhida vira a referência — é informação de
 * verdade, dada pela própria pessoa ("Depois de Rua Mascarenhas de Moraes"), não enchimento.
 */
const comReferencia = (a: AddressInput): AddressInput =>
  a.reference.trim() || !a.betweenStreets.trim() ? a : { ...a, reference: a.betweenStreets }

/** O resumo de uma linha, igual ao que o servidor monta: rua e número, sem repetir o apelido. */
const resumo = (a: { streetName: string; number: string }) => [a.streetName, a.number].filter(Boolean).join(', ')

export function CheckoutForm({ kind, locale, currencyPref, addresses: initialAddresses }: Props) {
  const router = useRouter()
  const t = (key: string) => copyT(key, locale)

  const [addresses, setAddresses] = useState(initialAddresses)
  const [dropoffId, setDropoffId] = useState(addresses[0]?.id ?? '')
  const [pickupId, setPickupId] = useState(addresses[0]?.id ?? '')
  /** Enquanto grava as pontas do trajeto que atravessou o login, a tela não deve parecer vazia. */
  const [importing, setImporting] = useState(false)

  // O TRAJETO QUE ATRAVESSOU O LOGIN. Quem montou o pedido na tela inicial sem conta chega aqui depois de se
  // cadastrar; sem isto, tudo o que a pessoa escolheu some e ela encara duas listas vazias (conta nova não tem
  // endereço nenhum). Então as duas pontas viram endereços dela agora, e ficam salvas para a próxima vez.
  useEffect(() => {
    const trip = takeTrip()
    if (!trip) return
    const pontas = [trip.from, trip.to]
    if (pontas.some((p) => !p.address)) return // atalho de GPS: coordenada sem rua, não dá para gravar
    setImporting(true)
    void (async () => {
      try {
        const salvos = []
        for (const p of pontas) salvos.push(await saveAddress(comReferencia(p.address!)))
        const novos = salvos.map((a) => ({ id: a.id, label: a.label, summary: resumo(a) }))
        setAddresses((anteriores) => [...novos, ...anteriores.filter((a) => !novos.some((n) => n.id === a.id))])
        setPickupId(salvos[0].id)
        setDropoffId(salvos[1].id)
      } catch {
        // Gravar falhou. A tela continua utilizável com o que a conta já tiver, mas CALAR seria pior: a pessoa
        // montou um trajeto, entrou, e precisa saber por que ele não está aqui.
        setError(t('trip_import_failed'))
      } finally {
        setImporting(false)
      }
    })()
  }, [])
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
    () => ({ kind, pickupAddressId: pickupId, dropoffAddressId: dropoffId }),
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

  /**
   * O texto de uma opção. O apelido só entra se ACRESCENTAR algo: sem apelido próprio o servidor usa a própria
   * rua, e mostrar os dois dava "Avenida Simões Lopes Neto, 706 — Avenida Simões Lopes Neto, 706".
   */
  const textoDoEndereco = (a: CheckoutAddress) => {
    const apelido = a.label.trim()
    const resumoDele = a.summary.trim()
    if (!resumoDele) return apelido
    if (!apelido || resumoDele.startsWith(apelido) || apelido.startsWith(resumoDele)) return resumoDele
    return `${apelido} — ${resumoDele}`
  }

  const addressSelect = (id: string, label: string, value: string, set: (v: string) => void) => (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      <select id={id} value={value} onChange={(e) => set(e.target.value)} className={selectClass} disabled={importing}>
        {addresses.map((a) => (
          <option key={a.id} value={a.id}>
            {textoDoEndereco(a)}
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
            className={`${k === kind ? 'bg-sol text-noite' : 'border border-borda text-white/90'} inline-flex min-h-11 flex-1 items-center justify-center rounded-lg px-3 text-sm font-semibold`}
          >
            {t(`kind_${k}`)}
          </Link>
        ))}
      </nav>

      {importing ? (
        /* As pontas do trajeto estão virando endereços da conta neste instante. Sem este aviso a tela aparece
           vazia por um segundo e parece que o pedido se perdeu — que é exatamente o que ela não pode parecer. */
        <p role="status" className="rounded-xl border border-borda bg-superficie p-4 text-white/80">
          {t('importing_trip')}
        </p>
      ) : addresses.length === 0 ? (
        <div className="rounded-xl border border-borda bg-superficie p-4">
          <p className="text-white/80">{t('no_addresses')}</p>
          {/* Dois caminhos, e o primeiro é o natural: montar o trajeto onde ele se monta, com busca de rua,
              quadra e referência. Mandar só para o cadastro de endereço é pedir trabalho em dobro. */}
          <Link href="/" className={`${primaryButtonClass} mt-3`}>
            {t('build_trip')}
          </Link>
          <Link href="/enderecos/novo" className={`${secondaryButtonClass} mt-2 w-full`}>
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
            <label key={m} className="flex min-h-11 items-center gap-3 rounded-lg border border-borda px-3 py-2">
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
