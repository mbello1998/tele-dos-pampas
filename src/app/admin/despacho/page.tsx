import type { Metadata } from 'next'
import type { DispatchCourier } from '@/components/admin/CourierSelect'
import { OrderRow, type DispatchOrder } from '@/components/admin/OrderRow'
import { requireRole } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'
import { CLOSED_STATUSES, type TransitionRow } from './transitions'

export const metadata: Metadata = { title: 'Despacho: Tele dos Pampas', robots: { index: false } }
export const dynamic = 'force-dynamic'

const ERRORS: Record<string, string> = {
  invalid: 'Pedido inválido: recarregue a tela.',
  reason: 'O motivo é obrigatório.',
  forbidden: 'Sem permissão para esta ação.',
  stale: 'O pedido já mudou (outra pessoa mexeu antes). Veja o estado atual abaixo e tente de novo.',
  notfound: 'Pedido ou motoboy não encontrado.',
  failed: 'Não foi possível concluir. Tente de novo.',
  unauthenticated: 'Sessão vencida: entre de novo.',
}

const ORDER_COLUMNS =
  'id, code, kind, status, courier_id, fleet_id, pickup_address, dropoff_address, total_charged, currency_charged, created_at, status_updated_at, merchant:merchants(name, city)'

/**
 * Console de despacho. Deliberadamente simples: uma tabela dos pedidos ativos e, em cada um, só os botões que
 * o banco aceita. Existe para o negócio funcionar por telefone e rádio antes de haver painel de motoboy ou de
 * lojista. A proteção real é o banco (RLS e transition_order); requireRole só decide o que a tela mostra.
 */
export default async function Despacho({ searchParams }: { searchParams: Promise<{ erro?: string }> }) {
  await requireRole('admin', { next: '/admin/despacho' })
  const { erro } = await searchParams
  const supabase = await createClient()
  const [orders, transitions, couriers] = await Promise.all([
    supabase
      .from('orders')
      .select(ORDER_COLUMNS)
      .not('status', 'in', `(${CLOSED_STATUSES.join(',')})`)
      .order('created_at', { ascending: true })
      .limit(200),
    supabase.from('status_transitions').select('kind, from_status, to_status, allowed_role'),
    supabase.rpc('dispatch_couriers', { p_city: null }),
  ])
  const failed = orders.error ?? transitions.error ?? couriers.error
  const list = (orders.data ?? []) as unknown as DispatchOrder[]
  const rows = (transitions.data ?? []) as TransitionRow[]
  const people = (couriers.data ?? []) as DispatchCourier[]

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="text-2xl font-bold">Despacho</h1>
      <p className="mt-1 text-sm text-white/65">Pedidos ativos. Toda ação do admin exige um motivo e fica registrada.</p>
      {erro && ERRORS[erro] ? (
        <p role="alert" className="mt-4 rounded border border-red-400/60 px-3 py-2 text-sm text-red-200" data-testid="dispatch-error">
          {ERRORS[erro]}
        </p>
      ) : null}
      {failed ? <p role="alert" className="mt-4 text-red-200">Não foi possível carregar o despacho.</p> : null}
      <table className="mt-6 w-full text-left">
        <thead className="text-xs uppercase text-white/60">
          <tr>
            <th className="px-2 py-2">Código</th>
            <th className="px-2 py-2">Tipo</th>
            <th className="px-2 py-2">Situação</th>
            <th className="px-2 py-2">Rota</th>
            <th className="px-2 py-2">Motoboy</th>
            <th className="px-2 py-2">Ações</th>
          </tr>
        </thead>
        <tbody>
          {list.map((o) => (
            <OrderRow key={o.id} order={o} rows={rows} couriers={people} />
          ))}
        </tbody>
      </table>
      {!failed && list.length === 0 ? <p className="mt-6 text-white/70" data-testid="empty">Nenhum pedido ativo.</p> : null}
    </main>
  )
}
