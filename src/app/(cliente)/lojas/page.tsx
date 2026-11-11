// Lojas: a vitrine do cliente. Server Component.
//
// Lê `merchants_public` (a view), NUNCA `merchants`: a tabela carrega commission_pct, o acordo comercial da
// plataforma com a loja, e não é lida por ninguém da API (RLS). A view só tem as colunas voltadas ao cliente e só
// devolve lojas aprovadas.
//
// A VITRINE É PÚBLICA (migration 0028): não exige login. Entrar é exigido para PEDIR, não para olhar o cardápio.
import type { Metadata } from 'next'
import { MerchantCard } from '@/components/catalog/MerchantCard'
import { catalogT } from '@/lib/cart/copy'
import { MERCHANT_COLUMNS, type MerchantRow } from '@/lib/cart/catalog-map'
import { isMerchantOpen, type MerchantHoursRow } from '@/lib/cart/open'
import { loadServiceWindows } from '@/lib/cart/service-window'
import { getLocale } from '@/lib/i18n/server'
import { createClient } from '@/lib/supabase/server'

export const metadata: Metadata = { title: 'Tele dos Pampas', robots: { index: false } }
// A abertura depende da hora de agora e da sessão: nada aqui pode ser servido do cache.
export const dynamic = 'force-dynamic'

export default async function Lojas() {
  const locale = await getLocale()
  const supabase = await createClient()

  const { data: merchants, error } = await supabase.from('merchants_public').select(MERCHANT_COLUMNS).order('name')
  if (error) throw new Error(`lojas: leitura de merchants_public falhou (${error.code ?? 'sem código'})`)
  const rows = (merchants ?? []) as unknown as MerchantRow[]

  const hoursByMerchant = new Map<string, MerchantHoursRow[]>()
  if (rows.length > 0) {
    const { data: hours, error: hoursError } = await supabase
      .from('merchant_hours')
      .select('merchant_id,weekday,opens_at,closes_at')
      .in('merchant_id', rows.map((m) => m.id))
    if (hoursError) throw new Error(`lojas: leitura de merchant_hours falhou (${hoursError.code ?? 'sem código'})`)
    for (const h of (hours ?? []) as (MerchantHoursRow & { merchant_id: string })[]) {
      const list = hoursByMerchant.get(h.merchant_id) ?? []
      list.push(h)
      hoursByMerchant.set(h.merchant_id, list)
    }
  }

  const now = new Date()
  // Horário de serviço do município, da mesma função que o quote_order usa (falha fechado).
  const service = await loadServiceWindows(supabase, rows.map((m) => m.city), now)
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-6">
      <h1 className="text-2xl font-semibold">{catalogT('catalog.shops', locale)}</h1>
      {rows.length === 0 ? (
        <p className="mt-4 text-white/70">{catalogT('catalog.no_merchants', locale)}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {rows.map((m) => (
            <li key={m.id}>
              <MerchantCard merchant={m} isOpen={isMerchantOpen(m, hoursByMerchant.get(m.id) ?? [], now, service.get(m.city) === true)} locale={locale} />
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
