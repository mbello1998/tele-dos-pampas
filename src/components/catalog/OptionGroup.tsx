'use client'
// Um grupo de opções de um item. Controlado: quem guarda a seleção é o ItemCard. Desabilita o que passaria do
// máximo, mas a regra de verdade está em toggleOption/selectionIssue e, por cima de tudo, no servidor.
import { catalogT, fmt, type Translate } from '@/lib/cart/copy'
import { toDisplayAmount } from '@/lib/cart/money'
import { effectiveMin } from '@/lib/cart/options'
import type { Currency, DisplayFx, Locale, OptionGroupData } from '@/lib/cart/types'
import { formatMoney } from '@/lib/money/format'

type Props = {
  group: OptionGroupData
  selected: readonly string[]
  onToggle: (optionId: string) => void
  currency: Currency
  locale: Locale
  fx: DisplayFx | null
  /** Padrão: catalogT. Opcional porque uma função não atravessa a fronteira Server -> Client Component. */
  t?: Translate
  /** Evita colisão de name/id quando o mesmo item aparece duas vezes na página. */
  idPrefix?: string
}

function deltaText(delta: number, currency: Currency, locale: Locale, fx: DisplayFx | null): string | null {
  const useUyu = currency === 'UYU' && fx !== null
  const amount = useUyu ? toDisplayAmount(delta, 'UYU', fx) : delta
  if (amount === 0) return null
  const sign = amount > 0 ? '+' : '-'
  return `${sign}${formatMoney(Math.abs(amount), useUyu ? 'UYU' : 'BRL', locale)}`
}

export function OptionGroup({ group, selected, onToggle, currency, locale, fx, t = catalogT, idPrefix = '' }: Props) {
  const chosen = group.options.filter((o) => selected.includes(o.id)).length
  const single = group.maxSelect === 1
  const min = effectiveMin(group)
  const full = chosen >= group.maxSelect
  const rule = single ? '' : fmt(t('catalog.up_to', locale), { n: group.maxSelect })

  return (
    <fieldset className="mt-3 border-0 p-0" data-group={group.id}>
      <legend className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
        <span>{group.name}</span>
        <span className={min > 0 ? 'text-xs font-normal text-sol' : 'text-xs font-normal text-white/60'}>
          {min > 0 ? t('catalog.required', locale) : t('catalog.optional', locale)}
        </span>
        {rule && <span className="text-xs font-normal text-white/60">{rule}</span>}
      </legend>
      <ul className="mt-1 space-y-1">
        {group.options.map((o) => {
          const isChecked = selected.includes(o.id)
          // Em escolha única trocar é permitido (toggleOption), então nada trava; em múltipla, trava o que passaria do máximo.
          // (Radio só quando é obrigatória: um radio não se desmarca, e uma escolha única opcional precisa poder ficar vazia.)
          const disabled = !o.isAvailable || (!single && full && !isChecked)
          const delta = deltaText(o.priceDeltaBrl, currency, locale, fx)
          const inputId = `${idPrefix}${o.id}`
          return (
            <li key={o.id}>
              <label htmlFor={inputId} className={`flex min-h-11 items-center gap-3 ${disabled ? 'opacity-50' : ''}`}>
                <input
                  id={inputId}
                  type={single && min > 0 ? 'radio' : 'checkbox'}
                  name={`${idPrefix}${group.id}`}
                  value={o.id}
                  checked={isChecked}
                  disabled={disabled}
                  onChange={() => onToggle(o.id)}
                  className="size-5 accent-sol"
                />
                <span className="flex-1">{o.name}</span>
                {delta && <span className="preco text-sm text-white/80">{delta}</span>}
              </label>
            </li>
          )
        })}
      </ul>
    </fieldset>
  )
}
