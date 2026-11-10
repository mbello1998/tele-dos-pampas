// Cartão de loja da listagem. Recebe só colunas de merchants_public: não existe comissão para vazar aqui.
// `isOpen` chega pronto (status + chave manual + faixa de horário, ver isMerchantOpen); o cartão só mostra.
import Link from 'next/link'
import { catalogT, fmt, type Translate } from '@/lib/cart/copy'
import type { Locale, PublicMerchant } from '@/lib/cart/types'

const FLAG: Record<string, string> = { BR: '🇧🇷', UY: '🇺🇾' }

type Props = { merchant: PublicMerchant; isOpen: boolean; locale: Locale; t?: Translate }

export function MerchantCard({ merchant, isOpen, locale, t = catalogT }: Props) {
  const cityName = t(`catalog.city.${merchant.city}`, locale)
  const city = cityName.startsWith('catalog.city.') ? merchant.city : cityName
  return (
    <Link
      href={`/lojas/${merchant.id}`}
      data-open={isOpen ? 'true' : 'false'}
      className={`block rounded-xl border border-white/10 bg-white/5 p-4 ${isOpen ? '' : 'opacity-70'}`}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg font-semibold">{merchant.name}</h2>
        <span
          className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${isOpen ? 'bg-campo text-white' : 'bg-white/15 text-white/80'}`}
        >
          {isOpen ? t('catalog.open', locale) : t('catalog.closed', locale)}
        </span>
      </div>
      <p className="mt-1 text-sm text-white/70">
        <span aria-hidden="true">{FLAG[merchant.country] ?? ''}</span> {city}
        {merchant.address_text ? ` · ${merchant.address_text}` : ''}
      </p>
      <p className="mt-1 text-sm text-white/70">{fmt(t('catalog.prep', locale), { n: merchant.prep_time_min })}</p>
    </Link>
  )
}
