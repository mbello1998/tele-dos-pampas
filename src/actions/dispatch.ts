'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { withDeadlockRetry } from '@/app/admin/despacho/retry'
import { STATUS_ORDER, type OrderStatus } from '@/app/admin/despacho/transitions'
import { requireRole } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'

/**
 * Despacho manual do admin. Cada ação:
 *  1. exige o papel admin (requireRole): é conveniência, quem recusa de verdade é o banco, que confere
 *     app_role() dentro de transition_order() e assign_courier();
 *  2. roda com a sessão do próprio admin (nenhuma chave secreta): o ator que fica em order_events é ele;
 *  3. repete UMA vez em 40P01 (deadlock conhecido entre o raio do motoboy e o teto da frota): o operador
 *     nunca vê isso.
 * O erro volta como código curto, nunca como texto do banco.
 */
export type DispatchError = 'invalid' | 'reason' | 'forbidden' | 'stale' | 'notfound' | 'failed'
export type DispatchResult = { ok: true } | { ok: false; error: DispatchError }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isStatus = (s: string): s is OrderStatus => (STATUS_ORDER as string[]).includes(s)

function classify(error: { code?: string }): DispatchError {
  switch (error.code) {
    case '22023': return 'reason'
    case '42501': return 'forbidden'
    case 'P0002': return 'notfound'
    // 55000: o pedido já não está onde a tela mostrava (outro operador, ou o próprio motoboy, mexeu antes)
    case '55000': return 'stale'
    default: return 'failed'
  }
}

async function run(rpc: 'transition_order' | 'assign_courier', args: Record<string, unknown>): Promise<DispatchResult> {
  await requireRole('admin', { next: '/admin/despacho' })
  const supabase = await createClient()
  const { error } = await withDeadlockRetry(async () => await supabase.rpc(rpc, args))
  if (error) return { ok: false, error: classify(error) }
  revalidatePath('/admin/despacho')
  return { ok: true }
}

/**
 * `expectedFrom` is the status the operator SAW. The database refuses the move when the order is no longer there
 * (a stale tab cannot drag a delivered order back to "ready"); the console always sends it.
 */
export async function transitionOrder(orderId: string, to: string, note: string, expectedFrom?: string): Promise<DispatchResult> {
  if (!UUID.test(orderId) || !isStatus(to) || (expectedFrom !== undefined && !isStatus(expectedFrom))) return { ok: false, error: 'invalid' }
  // Vazio é recusado aqui também (o banco recusaria): o operador vê "motivo obrigatório" sem ida à rede.
  if (note.trim() === '') return { ok: false, error: 'reason' }
  return run('transition_order', { p_order: orderId, p_to: to, p_note: note, p_expected_from: expectedFrom ?? null })
}

export async function assignCourier(orderId: string, courierId: string, note: string, expectedFrom?: string): Promise<DispatchResult> {
  if (!UUID.test(orderId) || !UUID.test(courierId) || (expectedFrom !== undefined && !isStatus(expectedFrom))) return { ok: false, error: 'invalid' }
  if (note.trim() === '') return { ok: false, error: 'reason' }
  return run('assign_courier', { p_order: orderId, p_courier: courierId, p_note: note, p_expected_from: expectedFrom ?? null })
}

// Envoltórios para <form action>: voltam para a tela com o resultado na URL (um código curto, não texto livre).
function back(result: DispatchResult): never {
  redirect(result.ok ? '/admin/despacho' : `/admin/despacho?erro=${result.error}`)
}

const fromOf = (f: FormData) => (f.has('from') ? String(f.get('from')) : undefined)

export async function transitionOrderForm(formData: FormData): Promise<void> {
  back(await transitionOrder(String(formData.get('order') ?? ''), String(formData.get('to') ?? ''), String(formData.get('note') ?? ''), fromOf(formData)))
}

export async function assignCourierForm(formData: FormData): Promise<void> {
  back(await assignCourier(String(formData.get('order') ?? ''), String(formData.get('courier') ?? ''), String(formData.get('note') ?? ''), fromOf(formData)))
}
