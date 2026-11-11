// A tela da loja: chamar um motoboy. Server Component fino: exige `merchant` (requireRole), lê as lojas e os
// endereços DO PRÓPRIO dono (RLS) e entrega a ilha de cliente. O preço não é calculado aqui nem lá: vem do
// servidor (quoteShopDelivery / createShopDelivery).
import type { Metadata } from 'next'
import { requireRole } from '@/lib/auth/session'
import { getLocale } from '@/lib/i18n/server'
import { createClient } from '@/lib/supabase/server'
import { SHOP_COPY } from '@/components/shop/copy'
import { ShopDeliveryScreen, type SavedAddress, type ShopOption } from '@/components/shop/ShopDeliveryScreen'
import { ScreenBackdrop } from '@/components/shell/ScreenBackdrop'

export const metadata: Metadata = { title: 'Tele dos Pampas — chamar motoboy', robots: { index: false } }
export const dynamic = 'force-dynamic'

type AddressRow = { id: string; label: string | null; street_name: string | null; number: string | null }

export default async function EntregaDaLoja() {
  const { profile } = await requireRole('merchant', { next: '/loja/entrega' })
  const locale = await getLocale()
  const c = SHOP_COPY[locale]
  const supabase = await createClient()

  const [shops, addresses] = await Promise.all([
    supabase.from('merchants').select('id,name').eq('status', 'approved').order('name', { ascending: true }),
    supabase
      .from('addresses')
      .select('id,label,street_name,number')
      .order('label', { ascending: true })
      .limit(60),
  ])
  if (shops.error) throw new Error(`loja: leitura de merchants falhou (${shops.error.code ?? 'sem código'})`)
  if (addresses.error) throw new Error(`loja: leitura de addresses falhou (${addresses.error.code ?? 'sem código'})`)

  const options: ShopOption[] = (shops.data as { id: string; name: string }[]).map((s) => ({ id: s.id, name: s.name }))
  const saved: SavedAddress[] = (addresses.data as unknown as AddressRow[]).map((r) => ({
    id: r.id,
    label: r.label ?? r.street_name ?? '',
    summary: [r.street_name, r.number].filter(Boolean).join(', '),
  }))

  return (
    <>
      <ScreenBackdrop name="loja" />
      <main lang={locale} className="mx-auto min-h-dvh w-full max-w-[32rem] px-4 pb-16 pt-5">
      <header className="mb-5">
        <p className="font-[family-name:var(--font-display)] text-lg font-extrabold uppercase tracking-wide text-sol">
          Tele dos Pampas
        </p>
        <h1 className="font-[family-name:var(--font-display)] text-[clamp(2.25rem,11vw,3.25rem)] font-extrabold uppercase leading-[0.95]">
          {c.title}
        </h1>
        <p className="mt-2 text-base text-white/70">{c.sub}</p>
      </header>
      {options.length === 0 ? (
        <section role="status" className="rounded-xl border border-white/15 bg-white/[0.04] p-4">
          <h2 className="font-[family-name:var(--font-display)] text-2xl font-extrabold uppercase">{c.no_shop_title}</h2>
          <p className="mt-1 text-base text-white/70">{c.no_shop_text}</p>
        </section>
      ) : (
        <ShopDeliveryScreen locale={locale} currency={profile.currencyPref} shops={options} saved={saved} />
      )}
      </main>
    </>
  )
}
