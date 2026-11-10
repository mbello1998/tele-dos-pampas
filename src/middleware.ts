import { NextResponse, type NextRequest } from 'next/server'
import { adminGate, LOGIN_PATH, PENDING_PATH } from '@/lib/auth/access'
import { toProfile, PROFILE_COLUMNS } from '@/lib/auth/profile'
import { createMiddlewareClient, hasAuthCookie } from '@/lib/supabase/middleware'

/**
 * Duas tarefas:
 *  1. renovar a sessão do Supabase em toda rota de app (cookies de acesso vencem; só o middleware pode
 *     reescrevê-los antes da página renderizar);
 *  2. proteger /admin/*: sem sessão vai para /entrar?next=..., conta pending/blocked para /aguardando, e quem
 *     não é admin ativo para /.
 *
 * Isto é a PRIMEIRA barreira, não a única: cada página de /admin chama requireRole('admin'), e o que protege os
 * dados é o RLS. O papel é lido da linha de `profiles` (banco), nunca de um claim do JWT.
 * A landing (/ e /es) e os estáticos ficam fora do matcher: continuam estáticos, sem ida à rede.
 */
export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  const isAdminArea = pathname === '/admin' || pathname.startsWith('/admin/')

  const redirectTo = (path: string) => {
    const url = request.nextUrl.clone()
    url.pathname = path
    url.search = ''
    return url
  }

  // Anônimo (sem cookie de sessão): nada a renovar e nenhuma ida à rede.
  if (!hasAuthCookie(request)) {
    if (!isAdminArea) return NextResponse.next()
    const url = redirectTo(LOGIN_PATH)
    url.searchParams.set('next', pathname + search)
    return NextResponse.redirect(url)
  }

  const { supabase, applyTo } = createMiddlewareClient(request)
  // getUser() confere o token no servidor de autenticação (getSession() só leria o cookie, que o navegador controla)
  // e é a chamada que dispara a renovação.
  const { data } = await supabase.auth.getUser()
  const user = data.user

  if (!isAdminArea) return applyTo(NextResponse.next({ request }))

  const { data: row } = user
    ? await supabase.from('profiles').select(PROFILE_COLUMNS).eq('id', user.id).maybeSingle()
    : { data: null }
  const gate = adminGate(user, row ? toProfile(row) : null)
  if (gate.allow) return applyTo(NextResponse.next({ request }))

  if (gate.reason === 'anonymous') {
    const url = redirectTo(LOGIN_PATH)
    url.searchParams.set('next', pathname + search)
    return applyTo(NextResponse.redirect(url))
  }
  return applyTo(NextResponse.redirect(redirectTo(gate.reason === 'inactive' ? PENDING_PATH : '/')))
}

export const config = {
  // Tudo, menos: a landing (/ e /es), internos do Next, estáticos com extensão, e as pastas públicas.
  matcher: ['/((?!_next/|api/|hero/|data/|es$|favicon\\.ico$|.*\\.[a-zA-Z0-9]+$).+)'],
}
