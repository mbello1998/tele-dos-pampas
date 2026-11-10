'use client'
// Um item do cardápio com as opções e o botão de adicionar. O botão só habilita quando a loja está aberta, o item
// está disponível e todo grupo obrigatório tem escolha; o store revalida tudo, então a tela nunca é a única guarda.
import { useState } from 'react'
import { attemptAdd, type AddOutcome } from '@/lib/cart/add-flow'
import { cartStore, type CartStore } from '@/lib/cart/store'
import { catalogT, fmt, type Translate } from '@/lib/cart/copy'
import { formatDisplayMoney } from '@/lib/cart/money'
import { missingGroups, toggleOption } from '@/lib/cart/options'
import type { CartMerchant, CatalogItem, Currency, DisplayFx, Locale } from '@/lib/cart/types'
import { OptionGroup } from './OptionGroup'

type Props = {
  item: CatalogItem
  merchant: CartMerchant
  currency: Currency
  locale: Locale
  fx: DisplayFx | null
  /** Padrão: catalogT. Opcional porque uma função não atravessa a fronteira Server -> Client Component. */
  t?: Translate
  store?: CartStore
}

type Feedback = { kind: 'ok' | 'error'; text: string } | null

export function ItemCard({ item, merchant, currency, locale, fx, t = catalogT, store = cartStore }: Props) {
  const [selected, setSelected] = useState<string[]>([])
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null) // nome da loja do carrinho atual
  const [feedback, setFeedback] = useState<Feedback>(null)

  const missing = missingGroups(item, selected)
  const missingNames = item.groups.filter((g) => missing.includes(g.id)).map((g) => g.name)

  // Um motivo por vez, na ordem em que o cliente consegue agir: a loja, o item, depois as opções.
  const blockedReason = !merchant.isOpen
    ? t('catalog.merchant_closed', locale)
    : !item.isAvailable
      ? t('catalog.item_unavailable', locale)
      : missingNames.length
        ? fmt(t('catalog.choose', locale), { groups: missingNames.join(', ') })
        : null

  const add = (replaceCart = false) => {
    const outcome: AddOutcome = attemptAdd(store, merchant, item, selected, replaceCart)
    if (outcome.kind === 'added') {
      setSelected([])
      setPendingSwitch(null)
      setFeedback({ kind: 'ok', text: t('catalog.added', locale) })
    } else if (outcome.kind === 'confirm_switch') {
      setPendingSwitch(outcome.currentMerchantName)
    } else {
      const text = t(outcome.messageKey, locale)
      setFeedback({ kind: 'error', text: text === outcome.messageKey ? t('cart.error.generic', locale) : text })
    }
  }

  return (
    <article className="rounded-xl border border-white/10 bg-white/5 p-4" data-item={item.id}>
      <div className="flex gap-3">
        {item.photoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={item.photoUrl} alt="" loading="lazy" width={80} height={80} className="size-20 shrink-0 rounded-lg object-cover" />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">{item.name}</h3>
          {item.description && <p className="mt-0.5 text-sm text-white/70">{item.description}</p>}
          <p className="preco mt-1 font-semibold text-sol">{formatDisplayMoney(item.priceBrl, currency, locale, fx)}</p>
        </div>
      </div>

      {item.isAvailable &&
        item.groups.map((g) => (
          <OptionGroup
            key={g.id}
            group={g}
            selected={selected}
            onToggle={(id) => setSelected((cur) => toggleOption(g, cur, id))}
            currency={currency}
            locale={locale}
            fx={fx}
            t={t}
            idPrefix={`${item.id}-`}
          />
        ))}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-action="add"
          disabled={blockedReason !== null}
          onClick={() => add(false)}
          className="min-h-11 rounded-lg bg-sol px-4 font-semibold text-noite disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t('catalog.add', locale)}
        </button>
        {blockedReason && <span className="text-sm text-white/70">{blockedReason}</span>}
        <span role="status" aria-live="polite" className={`text-sm ${feedback?.kind === 'error' ? 'text-brasa' : 'text-white/80'}`}>
          {feedback?.text}
        </span>
      </div>

      {pendingSwitch !== null && (
        <div role="alertdialog" aria-labelledby={`${item.id}-switch`} className="mt-3 rounded-lg border border-sol/60 bg-noite p-3">
          <p id={`${item.id}-switch`} className="font-semibold">
            {t('cart.switch_title', locale)}
          </p>
          <p className="mt-1 text-sm text-white/80">
            {fmt(t('cart.switch_body', locale), { current: pendingSwitch, next: merchant.name })}
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" data-action="switch-confirm" onClick={() => add(true)} className="min-h-11 rounded-lg bg-sol px-4 font-semibold text-noite">
              {t('cart.switch_confirm', locale)}
            </button>
            <button type="button" data-action="switch-cancel" onClick={() => setPendingSwitch(null)} className="min-h-11 rounded-lg border border-white/30 px-4">
              {t('cart.switch_cancel', locale)}
            </button>
          </div>
        </div>
      )}
    </article>
  )
}
