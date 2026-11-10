// A camada de sessão que as telas consomem. SOMENTE no servidor (Server Components, Server Actions, Route Handlers).
import 'server-only'
import { cache } from 'react'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { LOGIN_PATH, PENDING_PATH, safeNextPath } from './access'
import { fetchOwnProfile } from './profile'
import type { Session, UserRole } from './types'

/**
 * A sessão da requisição, ou null (anônimo, sessão vencida ou usuário sem perfil).
 *
 * O usuário é verificado com `auth.getUser()`, que confere o token com o servidor de autenticação. Não usamos
 * `auth.getSession()` aqui: ele lê o cookie sem verificar, e cookie é coisa que o navegador controla.
 * O papel vem da linha de `profiles` lida pelo banco com a sessão do próprio usuário (nunca de claim do JWT).
 * Memoizado por requisição: várias chamadas na mesma renderização custam uma ida ao servidor.
 */
export const getSession = cache(async (): Promise<Session | null> => {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()
  if (error || !data.user) return null
  const profile = await fetchOwnProfile(supabase, data.user.id)
  if (!profile) return null
  return { user: { id: data.user.id, email: data.user.email ?? null }, profile }
})

/**
 * Exige um papel (ou qualquer um de uma lista) numa página de Server Component. Devolve a sessão.
 *  - sem sessão: redireciona para /entrar (com `next`, se informado);
 *  - conta pending ou blocked: para /aguardando (o banco também lhes nega todo privilégio);
 *  - papel diferente: para /.
 * Chame em CADA página protegida: layouts não rodam de novo a cada navegação, então não são lugar de guarda.
 * A proteção real dos dados é o RLS; isto decide o que a tela mostra.
 */
export async function requireRole(role: UserRole | readonly UserRole[], options: { next?: string } = {}): Promise<Session> {
  const session = await getSession()
  if (!session) {
    redirect(options.next ? `${LOGIN_PATH}?next=${encodeURIComponent(safeNextPath(options.next))}` : LOGIN_PATH)
  }
  if (session.profile.status !== 'active') redirect(PENDING_PATH)
  const allowed: readonly UserRole[] = typeof role === 'string' ? [role] : role
  if (!allowed.includes(session.profile.role)) redirect('/')
  return session
}
