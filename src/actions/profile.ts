'use server'

import { PROFILE_COLUMNS, toProfile } from '@/lib/auth/profile'
import type { Profile } from '@/lib/auth/types'
import { setLocaleCookie } from '@/lib/i18n/server'
import { parseProfileInput, type ProfileInput } from '@/lib/profile/input'
import { createClient } from '@/lib/supabase/server'

export type { ProfileInput }
export type UpdateProfileResult =
  | { ok: true; profile: Profile }
  | { ok: false; error: 'unauthenticated' | 'invalid' | 'forbidden' | 'failed'; field?: string }

/**
 * Atualiza o perfil de QUEM ESTÁ LOGADO. O id vem da sessão verificada, nunca da entrada.
 *
 * - Só full_name, phone, locale, currency_pref, home_city e country. Qualquer outra chave (role, status, id...)
 *   recusa a chamada inteira antes de tocar o banco (parseProfileInput).
 * - locale e currencyPref são independentes: só vão para o UPDATE os campos presentes na entrada.
 * - O UPDATE roda com a sessão do usuário, então valem o RLS (profiles_update_own, só conta active) e o
 *   guard de colunas do banco como segunda barreira. Aqui não há chave secreta.
 * - Conta pending ou blocked não atualiza nada: o RLS não alcança a linha, e a resposta é `forbidden`.
 * - Se o locale mudou, o cookie do aparelho acompanha a escolha.
 */
export async function updateProfile(input: ProfileInput): Promise<UpdateProfileResult> {
  const parsed = parseProfileInput(input)
  if (!parsed.ok) return { ok: false, error: 'invalid', field: parsed.field }

  const supabase = await createClient()
  const { data: auth, error: authError } = await supabase.auth.getUser()
  if (authError || !auth.user) return { ok: false, error: 'unauthenticated' }

  const { data, error } = await supabase.from('profiles').update(parsed.patch).eq('id', auth.user.id).select(PROFILE_COLUMNS)
  if (error) return { ok: false, error: error.code === '42501' ? 'forbidden' : 'failed' }
  if (!data || data.length !== 1) return { ok: false, error: 'forbidden' }

  if (parsed.patch.locale) await setLocaleCookie(parsed.patch.locale)
  return { ok: true, profile: toProfile(data[0]) }
}
