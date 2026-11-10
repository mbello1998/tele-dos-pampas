// Aviso de cotação defasada ao lado dos preços em pesos. Só aparece em pesos e só quando a taxa não é a do dia.
import { catalogT, fmt, type Translate } from '@/lib/cart/copy'
import type { Currency, DisplayFx, Locale } from '@/lib/cart/types'

type Props = { currency: Currency; fx: DisplayFx | null; locale: Locale; t?: Translate }

export function FxNote({ currency, fx, locale, t = catalogT }: Props) {
  if (currency !== 'UYU' || !fx?.note) return null
  const text = fx.note.kind === 'dated' ? fmt(t('fx.dated', locale), { date: fx.note.date }) : t('fx.default', locale)
  return (
    <p role="note" data-fx-note={fx.note.kind} className="text-xs text-sol">
      {text}
    </p>
  )
}
