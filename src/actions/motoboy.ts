'use server'

import { revalidatePath } from 'next/cache'
import { withDeadlockRetry } from '@/app/admin/despacho/retry'
import { STATUS_ORDER, type OrderStatus } from '@/app/admin/despacho/transitions'
import { requireRole } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'

/**
 * Aceitar um chamado (e dar os passos seguintes dele). Não existe "aceite próprio" aqui: é transition_order(),
 * a única porta do banco, que trava a linha (FOR UPDATE) ANTES de validar. Dois motoboys tocando ao mesmo tempo
 * são serializados: o segundo acorda, lê a linha já com motoboy e é recusado (55000). Nenhum dos dois ganha por
 * estar com a tela mais nova; ganha quem o banco atender primeiro.
 *
 * `from` é o estado que o motoboy VIU. O banco recusa se o pedido já saiu dele, então uma tela esquecida no
 * suporte do guidão não aplica um passo a um pedido que mudou (55000 também).
 *
 * Repete UMA vez em 40P01 (deadlock conhecido entre o raio do motoboy e o teto da frota): o motoboy nunca vê isso.
 * O erro volta como código curto, nunca como texto do banco.
 */
export type CallError = 'invalid' | 'gone' | 'cross_border' | 'passenger' | 'forbidden' | 'failed'
export type CallResult = { ok: true } | { ok: false; error: CallError }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isStatus = (s: string): s is OrderStatus => (STATUS_ORDER as string[]).includes(s)

function classify(error: { code?: string; hint?: string | null }): CallError {
  switch (error.code) {
    // 55000: outro motoboy pegou antes, ou o pedido já não está onde a tela mostrava
    case '55000': return 'gone'
    // 23514: o próprio motoboy marcou que não faz esse tipo de corrida; o HINT diz qual (ver 0032)
    case '23514': return error.hint === 'passenger' ? 'passenger' : 'cross_border'
    case '42501': return 'forbidden'
    case 'P0002': return 'gone'
    default: return 'failed'
  }
}

export async function moveCall(orderId: string, to: string, from: string): Promise<CallResult> {
  if (!UUID.test(orderId) || !isStatus(to) || !isStatus(from)) return { ok: false, error: 'invalid' }
  await requireRole('courier', { next: '/motoboy' })
  const supabase = await createClient()
  const { error } = await withDeadlockRetry(
    async () => await supabase.rpc('transition_order', { p_order: orderId, p_to: to, p_note: null, p_expected_from: from }),
  )
  if (error) return { ok: false, error: classify(error) }
  revalidatePath('/motoboy')
  return { ok: true }
}
