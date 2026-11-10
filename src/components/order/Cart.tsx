'use client'
// Carrinho. O subtotal é uma ESTIMATIVA VISUAL dos itens (em centavos, a partir do preço de vitrine): o preço de
// verdade, com entrega, vem do servidor no resumo (PriceSummary). Em pesos, o subtotal é UMA conversão do total em
// reais, com teto: nunca a soma de linhas já arredondadas, que acumularia um peso a mais por linha.
import Link from 'next/link'
import { cartStore, lineTotalBrl, subtotalBrlOf, useCart, type CartState, type CartStore } from '@/lib/cart/store'
import { catalogT, fmt, type Translate } from '@/lib/cart/copy'
import { formatDisplayMoney } from '@/lib/cart/money'
import type { Currency, DisplayFx, Locale } from '@/lib/cart/types'
import { FxNote } from '@/components/catalog/FxNote'

type Props = {
  currency: Currency
  locale: Locale
  fx: DisplayFx | null
  /** Padrão: catalogT. Opcional porque uma função não atravessa a fronteira Server -> Client Component. */
  t?: Translate
  /** Passe o estado para renderizar um carrinho específico (testes, servidor); sem ele, usa o carrinho da aba. */
  state?: CartState
  store?: CartStore
  checkoutHref?: string
}

export function Cart({ currency, locale, fx, t = catalogT, state, store = cartStore, checkoutHref }: Props) {
  const live = useCart(store)
  const cart = state ?? live
  const money = (brl: number) => formatDisplayMoney(brl, currency, locale, fx)

  if (cart.lines.length === 0) {
    return (
      <section aria-label={t('cart.title', locale)} className="rounded-xl border border-white/10 bg-white/5 p-4">
        <h2 className="font-semibold">{t('cart.title', locale)}</h2>
        <p className="mt-2 text-white/70">{t('cart.empty', locale)}</p>
      </section>
    )
  }

  return (
    <section aria-label={t('cart.title', locale)} className="rounded-xl border border-white/10 bg-white/5 p-4">
      <h2 className="font-semibold">{t('cart.title', locale)}</h2>
      <p className="text-sm text-white/70">{fmt(t('cart.from', locale), { name: cart.merchantName ?? '' })}</p>

      <ul className="mt-3 divide-y divide-white/10">
        {cart.lines.map((line) => {
          const names = line.item.groups.flatMap((g) => g.options).filter((o) => line.optionIds.includes(o.id)).map((o) => o.name)
          return (
            <li key={line.lineId} className="py-3" data-line={line.lineId}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{line.item.name}</span>
                <span className="preco shrink-0">{money(lineTotalBrl(line))}</span>
              </div>
              {names.length > 0 && <p className="text-sm text-white/70">{names.join(', ')}</p>}
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  aria-label={t('cart.less', locale)}
                  onClick={() => store.setQty(line.lineId, line.qty - 1)}
                  className="size-11 rounded-lg border border-white/30"
                >
                  −
                </button>
                <span aria-label={t('cart.qty', locale)} className="preco min-w-8 text-center">
                  {line.qty}
                </span>
                <button
                  type="button"
                  aria-label={t('cart.more', locale)}
                  onClick={() => store.setQty(line.lineId, line.qty + 1)}
                  className="size-11 rounded-lg border border-white/30"
                >
                  +
                </button>
                <button type="button" onClick={() => store.removeItem(line.lineId)} className="ml-auto min-h-11 px-2 text-sm text-white/70 underline">
                  {t('cart.remove', locale)}
                </button>
              </div>
            </li>
          )
        })}
      </ul>

      <div data-testid="cart-subtotal" className="mt-3 flex items-baseline justify-between gap-3 border-t border-white/10 pt-3">
        <span className="font-semibold">{t('cart.items_estimate', locale)}</span>
        <span className="preco text-lg font-semibold text-sol">{money(subtotalBrlOf(cart))}</span>
      </div>
      <p className="mt-1 text-xs text-white/60">{t('cart.estimate_note', locale)}</p>
      <div className="mt-1">
        <FxNote currency={currency} fx={fx} locale={locale} t={t} />
      </div>

      {checkoutHref && (
        <Link href={checkoutHref} className="mt-4 block min-h-11 rounded-lg bg-sol px-4 py-3 text-center font-semibold text-noite">
          {t('cart.checkout', locale)}
        </Link>
      )}
    </section>
  )
}
