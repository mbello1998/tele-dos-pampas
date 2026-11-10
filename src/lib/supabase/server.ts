// Cliente do Supabase para o SERVIDOR (Server Components, Server Actions, Route Handlers).
// Age como o usuário da requisição: a sessão vem dos cookies e o RLS vale integralmente. Chave publicável
// apenas; este módulo NÃO exporta cliente com a chave secreta de propósito (ela ignora RLS e não deve ficar
// ao alcance de quem só precisa de uma sessão).
import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

/** Um cliente por requisição: crie dentro da função que o usa, nunca em escopo de módulo. */
export async function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY precisam estar definidas')
  const store = await cookies()
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll(list) {
        // Server Component não pode escrever cookie; quem renova a sessão nesse caso é o middleware.
        try {
          for (const { name, value, options } of list) store.set(name, value, options)
        } catch {
          /* chamado de um Server Component: ignorar */
        }
      },
    },
  })
}
