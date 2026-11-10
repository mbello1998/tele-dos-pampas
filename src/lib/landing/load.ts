// Leitura dos textos da landing, SOMENTE no servidor.
//
// Usa a secret key (que ignora RLS) via PostgREST, em Server Component: a chave nunca chega ao
// navegador, e a landing não depende de acesso anônimo do navegador ao banco. Só lê linhas
// `is_public = true`, que é o que um visitante anônimo poderia ver de qualquer forma.
// O resultado entra no cache de dados do Next e é revalidado (ver `revalidate` nas páginas).
import { LANDING_KEYS, type Locale, type LandingContent, parseLandingContent, type SettingRow } from './content'

export const LANDING_REVALIDATE_SECONDS = 300

export async function loadLandingContent(locale: Locale): Promise<LandingContent> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const secret = process.env.SUPABASE_SECRET_KEY
  if (!url || !secret) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SECRET_KEY precisam estar definidas para ler os textos da landing')
  }
  const keys = Object.values(LANDING_KEYS).join(',')
  const res = await fetch(`${url}/rest/v1/settings?select=key,value&is_public=eq.true&key=in.(${keys})`, {
    headers: { apikey: secret },
    next: { revalidate: LANDING_REVALIDATE_SECONDS },
  })
  if (!res.ok) throw new Error(`settings: o Supabase respondeu ${res.status}`)
  return parseLandingContent((await res.json()) as SettingRow[], locale)
}
