// Resumo de preço: EXIBE a cotação que o servidor devolveu, linha por linha. Não soma, não recalcula, não ajusta.
// O total em reais é `totalBrl` e o total em pesos é `totalUyu`, exatamente como vieram. A única conta aqui é a
// conversão de cada LINHA para pesos, só de exibição, e só quando o servidor mandou a taxa que usou (`fxRateUsed`).
import { convertBrlToUyu, formatMoney } from '@/lib/money/format'
import { catalogT, type Translate } from '@/lib/cart/copy'
import type { Currency, Locale } from '@/lib/cart/types'
import type { Quote, ServerQuote } from '@/lib/pricing/types'

/**
 * O que o navegador recebe: `Quote` mais os campos de câmbio da cotação do servidor. Nunca `ServerQuote` inteiro:
 * ele carrega `commissionBrl`, o acordo comercial da plataforma com a loja.
 */
export type PriceSummaryQuote = Quote & Partial<Pick<ServerQuote, 'totalUyu' | 'fxRateUsed' | 'fxStale'>>

type Props = {
  quote: PriceSummaryQuote
  currency: Currency
  locale: Locale
  t?: Translate
}

export function PriceSummary({ quote, currency, locale, t = catalogT }: Props) {
  if (quote.blocked) {
    return (
      <section aria-label={t('pricing.title', locale)} className="rounded-xl border border-brasa/60 bg-brasa/10 p-4">
        <div role="alert">
          <p className="font-semibold">{t('pricing.blocked_title', locale)}</p>
          <p className="mt-1 text-sm text-white/80">{quote.blockedReason || t('pricing.blocked_fallback', locale)}</p>
        </div>
      </section>
    )
  }

  const rate = quote.fxRateUsed
  const linesInPesos = currency === 'UYU' && typeof rate === 'number' && Number.isFinite(rate) && rate > 0
  const lineText = (amountBrl: number): string =>
    linesInPesos ? formatMoney(convertBrlToUyu(amountBrl, rate, 0), 'UYU', locale) : formatMoney(amountBrl, 'BRL', locale)

  const totals: { key: string; label: string; text: string }[] = [
    { key: 'brl', label: t('pricing.total_brl', locale), text: formatMoney(quote.totalBrl, 'BRL', locale) },
  ]
  if (typeof quote.totalUyu === 'number') {
    totals.push({ key: 'uyu', label: t('pricing.total_uyu', locale), text: formatMoney(quote.totalUyu, 'UYU', locale) })
  }
  if (currency === 'UYU') totals.reverse()

  return (
    <section aria-label={t('pricing.title', locale)} className="rounded-xl border border-white/10 bg-white/5 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-white/70">{t('pricing.title', locale)}</h2>
      <dl className="mt-3 space-y-2">
        {quote.breakdown.map((line) => (
          <div key={line.key + line.labelKey} className="flex items-baseline justify-between gap-4" data-line={line.key}>
            <dt className="text-white/80">{t(line.labelKey, locale)}</dt>
            <dd className="preco shrink-0 text-right">{lineText(line.amountBrl)}</dd>
          </div>
        ))}
      </dl>
      <dl className="mt-3 space-y-1 border-t border-white/10 pt-3">
        {totals.map((row, i) => (
          <div key={row.key} className="flex items-baseline justify-between gap-4" data-total={row.key}>
            <dt className={i === 0 ? 'font-semibold' : 'text-sm text-white/70'}>{row.label}</dt>
            <dd className={`preco shrink-0 text-right ${i === 0 ? 'text-lg font-semibold text-sol' : 'text-sm text-white/70'}`}>
              {row.text}
            </dd>
          </div>
        ))}
      </dl>
      {linesInPesos && <p className="mt-3 text-xs text-white/60">{t('pricing.rounding_note', locale)}</p>}
      {quote.fxStale && (
        <p role="note" className="mt-2 text-xs text-sol">
          {t('pricing.stale', locale)}
        </p>
      )}
    </section>
  )
}
