'use server'

import { getSession } from '@/lib/auth/session'
import { isLocale, type Locale } from '@/lib/i18n'
import { setLocaleCookie } from '@/lib/i18n/server'
import { updateProfile } from './profile'

/**
 * Troca o idioma. Quem tem conta ativa grava no perfil; quem não tem (ou tem conta pending/blocked, que não
 * escreve em nada) fica com o cookie do aparelho. Não mexe na moeda: idioma e moeda são independentes.
 */
export async function setLocale(locale: Locale): Promise<{ ok: boolean }> {
  if (!isLocale(locale)) return { ok: false }
  const session = await getSession()
  if (session && session.profile.status === 'active') {
    const r = await updateProfile({ locale })
    return { ok: r.ok }
  }
  await setLocaleCookie(locale)
  return { ok: true }
}
