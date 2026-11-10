// Telefone de suporte (settings.support_phone, público), para a tela de espera de aprovação poder dizer
// "fale com a equipe". Só no servidor: mesma leitura da landing (chave secreta via PostgREST, só linha pública).
// Vazio ou indisponível devolve null e a tela esconde o botão: é um extra, e a falha dele não pode derrubar a
// tela que explica a uma pessoa por que ela não entra.
import 'server-only'

export async function loadSupportPhone(): Promise<string | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const secret = process.env.SUPABASE_SECRET_KEY
  if (!url || !secret) return null
  try {
    const res = await fetch(`${url}/rest/v1/settings?select=value&key=eq.support_phone&is_public=eq.true`, {
      headers: { apikey: secret },
      next: { revalidate: 300 },
    })
    if (!res.ok) return null
    const rows = (await res.json()) as { value: unknown }[]
    const value = rows[0]?.value
    const digits = typeof value === 'string' ? value.replace(/\D/g, '') : ''
    return digits.length >= 8 ? digits : null
  } catch {
    return null
  }
}
