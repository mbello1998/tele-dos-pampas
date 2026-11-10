// Cardápio de uma loja. Server Component; o carrinho e os botões são ilhas de cliente.
//
// O parâmetro `slug` é o id da loja (uuid): `merchants_public` não tem coluna de slug. Valida o formato antes de
// consultar, porque um id malformado faria o Postgres responder 22P02 e a página cair em erro em vez de 404.
//
// Preço aqui é VITRINE (preço canônico em BRL, convertido para pesos só para exibir). Quem cota o pedido é o
// servidor (quote_order); o que o cliente vê neste cardápio nunca é o que ele paga.
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { requireRole } from '@/lib/auth/session'
import { ItemCard } from '@/components/catalog/ItemCard'
import { Cart } from '@/components/order/Cart'
import { buildMenu, MERCHANT_COLUMNS, type CategoryRow, type ItemRow, type MerchantRow } from '@/lib/cart/catalog-map'
import { catalogT, fmt } from '@/lib/cart/copy'
import { FxNote } from '@/components/catalog/FxNote'
import { fxNoteFrom } from '@/lib/cart/fx-note'
import { isMerchantOpen, type MerchantHoursRow } from '@/lib/cart/open'
import { loadServiceWindows } from '@/lib/cart/service-window'
import { getEffectiveRate, toValidForDate } from '@/lib/fx/rate'
import { getLocale } from '@/lib/i18n/server'
import { createClient } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Tele dos Pampas', robots: { index: false } }
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const FLAG: Record<string, string> = { BR: '🇧🇷', UY: '🇺🇾' }

const ITEM_COLUMNS =
  'id,merchant_id,category_id,name,description,price_brl,photo_url,is_available,sort_order,' +
  'item_option_groups(id,name,min_select,max_select,is_required,item_options(id,group_id,name,price_delta_brl,is_available))'

export default async function Cardapio({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  if (!UUID.test(slug)) notFound()

  const { profile } = await requireRole('client', { next: `/lojas/${slug}` })
  const locale = await getLocale()
  const supabase = await createClient()

  const { data: merchant, error } = await supabase
    .from('merchants_public')
    .select(MERCHANT_COLUMNS)
    .eq('id', slug)
    .maybeSingle()
  if (error) throw new Error(`cardápio: leitura de merchants_public falhou (${error.code ?? 'sem código'})`)
  if (!merchant) notFound() // inexistente, não aprovada ou não visível a este cliente: a mesma resposta
  const shop = merchant as unknown as MerchantRow

  const [hoursRes, categoriesRes, itemsRes, rate] = await Promise.all([
    supabase.from('merchant_hours').select('weekday,opens_at,closes_at').eq('merchant_id', shop.id),
    supabase.from('catalog_categories').select('id,name,sort_order').eq('merchant_id', shop.id),
    supabase.from('catalog_items').select(ITEM_COLUMNS).eq('merchant_id', shop.id),
    getEffectiveRate(),
  ])
  for (const r of [hoursRes, categoriesRes, itemsRes]) {
    if (r.error) throw new Error(`cardápio: leitura do catálogo falhou (${r.error.code ?? 'sem código'})`)
  }

  const now = new Date()
  const service = await loadServiceWindows(supabase, [shop.city], now)
  const isOpen = isMerchantOpen(shop, (hoursRes.data ?? []) as MerchantHoursRow[], now, service.get(shop.city) === true)
  const sections = buildMenu((categoriesRes.data ?? []) as CategoryRow[], (itemsRes.data ?? []) as unknown as ItemRow[])
  const fx = { rate: rate.rate, spreadPct: rate.spreadPct, note: fxNoteFrom(rate, toValidForDate(now)) }
  const cartMerchant = { id: shop.id, name: shop.name, isOpen }
  const cityName = catalogT(`catalog.city.${shop.city}`, locale)

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6">
      <header>
        <h1 className="text-2xl font-semibold">{shop.name}</h1>
        <p className="mt-1 text-sm text-white/70">
          <span aria-hidden="true">{FLAG[shop.country] ?? ''}</span> {cityName}
          {shop.address_text ? ` · ${shop.address_text}` : ''} · {fmt(catalogT('catalog.prep', locale), { n: shop.prep_time_min })}
        </p>
        <p
          data-open={isOpen ? 'true' : 'false'}
          className={`mt-3 inline-block rounded-full px-3 py-1 text-sm font-semibold ${isOpen ? 'bg-campo text-white' : 'bg-white/15 text-white/80'}`}
        >
          {isOpen ? catalogT('catalog.open', locale) : catalogT('catalog.closed', locale)}
        </p>
      </header>

      <div className="mt-3">
        <FxNote currency={profile.currencyPref} fx={fx} locale={locale} />
      </div>

      {sections.length === 0 ? (
        <p className="mt-6 text-white/70">{catalogT('catalog.empty_menu', locale)}</p>
      ) : (
        sections.map((section) => (
          <section key={section.id ?? 'sem-categoria'} className="mt-6">
            <h2 className="text-lg font-semibold">{section.name ?? catalogT('catalog.uncategorized', locale)}</h2>
            <div className="mt-3 space-y-3">
              {section.items.map((item) => (
                <ItemCard key={item.id} item={item} merchant={cartMerchant} currency={profile.currencyPref} locale={locale} fx={fx} />
              ))}
            </div>
          </section>
        ))
      )}

      <div id="carrinho" className="mt-8">
        <Cart currency={profile.currencyPref} locale={locale} fx={fx} checkoutHref="/pedido/novo" />
      </div>
    </main>
  )
}
