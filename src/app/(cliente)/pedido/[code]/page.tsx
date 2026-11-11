import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { requireRole } from '@/lib/auth/session'
import { USER_ROLES } from '@/lib/auth/types'
import { getLocale } from '@/lib/i18n/server'
import { createClient } from '@/lib/supabase/server'
import { loadTracking } from './data'
import { fixtureFor } from './fixtures'
import { TrackingView } from './TrackingView'

// Posição e andamento são por pedido e por pessoa: nunca em cache compartilhado.
export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Acompanhar pedido', robots: { index: false } }

export default async function PedidoPage({ params }: { params: Promise<{ code: string }> }) {
  const { code: raw } = await params
  const code = decodeURIComponent(raw).trim().toUpperCase()

  const fixture = fixtureFor(code, (await headers()).get('host'))
  if (fixture) return <TrackingView data={fixture} locale="pt-BR" />

  // Qualquer papel pode ter feito um pedido; o que a pessoa enxerga quem decide é o RLS (só o próprio pedido).
  await requireRole(USER_ROLES, { next: `/pedido/${code}` })
  const supabase = await createClient()
  const data = await loadTracking(supabase, code)
  // Pedido que não existe e pedido de outra pessoa são indistinguíveis de propósito.
  if (!data) notFound()
  return <TrackingView data={data} locale={await getLocale()} />
}
