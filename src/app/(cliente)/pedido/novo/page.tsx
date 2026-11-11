// Confirmação do pedido. Server Component fino: exige cliente logado (requireRole), lê os endereços DELE (RLS) e
// entrega a ilha de cliente. O preço não é calculado aqui nem lá: vem do servidor (quoteOrder / createOrder).
import type { Metadata } from 'next'
import { requireRole } from '@/lib/auth/session'
import { getLocale } from '@/lib/i18n/server'
import { createClient } from '@/lib/supabase/server'
import { CheckoutForm, type CheckoutAddress } from './CheckoutForm'
import { copyT } from './copy'
import { CUSTOMER_KINDS, type OrderKind } from './order-core'
import { ScreenBackdrop } from '@/components/shell/ScreenBackdrop'

export const metadata: Metadata = { title: 'Tele dos Pampas', robots: { index: false } }
export const dynamic = 'force-dynamic'

type Row = { id: string; label: string | null; street_name: string | null; number: string | null; city: string }

export default async function NovoPedido({ searchParams }: { searchParams: Promise<{ kind?: string | string[] }> }) {
  const { kind: rawKind } = await searchParams
  const asked = Array.isArray(rawKind) ? rawKind[0] : rawKind
  const kind: OrderKind = CUSTOMER_KINDS.includes(asked as OrderKind) ? (asked as OrderKind) : 'ride'

  const { profile } = await requireRole('client', { next: `/pedido/novo?kind=${kind}` })
  const locale = await getLocale()
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('addresses')
    .select('id,label,street_name,number,city')
    .order('is_default', { ascending: false })
    .order('label', { ascending: true })
  if (error) throw new Error(`pedido: leitura de addresses falhou (${error.code ?? 'sem código'})`)

  const addresses: CheckoutAddress[] = (data as unknown as Row[]).map((r) => ({
    id: r.id,
    label: r.label ?? r.street_name ?? '',
    summary: [r.street_name, r.number].filter(Boolean).join(', '),
  }))

  return (
    <>
      <ScreenBackdrop name="pedido" />
      <main className="mx-auto w-full max-w-xl px-4 py-6">
      <h1 className="mb-5 text-2xl font-extrabold">{copyT('title', locale)}</h1>
      <CheckoutForm kind={kind} locale={locale} currencyPref={profile.currencyPref} addresses={addresses} />
    </main>
    </>
  )
}
