// Cliente do Supabase para o NAVEGADOR (Client Components). Usa só a chave publicável: o que ela pode fazer
// é decidido pelas policies de RLS, com a sessão do usuário. A chave secreta nunca aparece aqui.
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY precisam estar definidas')
  return createBrowserClient(url, key)
}
