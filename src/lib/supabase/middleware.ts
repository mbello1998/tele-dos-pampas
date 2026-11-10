// Cliente do Supabase para o middleware: renova a sessão (os cookies de acesso vencem e só o middleware pode
// reescrevê-los antes de a página renderizar) e deixa o middleware perguntar quem é o usuário e qual o papel dele.
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

/** Há cookie de sessão do Supabase nesta requisição? Sem ele a pessoa é anônima e não vale uma ida à rede. */
export const hasAuthCookie = (request: NextRequest): boolean =>
  request.cookies.getAll().some((c) => c.name.startsWith('sb-') && c.name.includes('-auth-token'))

export function createMiddlewareClient(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY precisam estar definidas')

  // O que a renovação escreveu: precisa ir tanto para a requisição que segue adiante quanto para a resposta.
  let written: { name: string; value: string; options: Parameters<NextResponse['cookies']['set']>[2] }[] = []
  let cacheHeaders: Record<string, string> = {}

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(list, headers) {
        for (const c of list) request.cookies.set(c.name, c.value)
        written = list.map((c) => ({ name: c.name, value: c.value, options: c.options }))
        cacheHeaders = headers
      },
    },
  })

  /** Aplica a sessão renovada (cookies e cabeçalhos anti-cache) a qualquer resposta, inclusive a de redirect. */
  const applyTo = <T extends NextResponse>(response: T): T => {
    for (const c of written) response.cookies.set(c.name, c.value, c.options)
    for (const [k, v] of Object.entries(cacheHeaders)) response.headers.set(k, v)
    return response
  }
  return { supabase, applyTo }
}
