// Idioma da requisição, no servidor. Ordem de precedência:
//   1. o perfil, para quem entrou e já fez o onboarding (a escolha dele, guardada no banco);
//   2. o cookie `tdp_locale` (escolha de quem não tem conta, ou a última deste aparelho);
//   3. o cabeçalho Accept-Language do navegador;
//   4. pt-BR.
// Quem entrou mas ainda não fez o onboarding tem o `locale` padrão do banco (pt-BR), que não é uma escolha:
// para esse caso valem o cookie e o navegador, e o onboarding grava a escolha de verdade.
import 'server-only'
import { cookies, headers } from 'next/headers'
import { isOnboarded } from '@/lib/auth/access'
import { getSession } from '@/lib/auth/session'
import { detectLocale, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from './detect'
import { isLocale, type Locale } from './index'

/** Idioma só pelo navegador (cookie e cabeçalho), sem olhar a sessão. */
export async function getBrowserLocale(): Promise<Locale> {
  const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value
  if (isLocale(fromCookie)) return fromCookie
  return detectLocale((await headers()).get('accept-language'))
}

export async function getLocale(): Promise<Locale> {
  const session = await getSession()
  if (session && session.profile.status === 'active' && isOnboarded(session.profile)) return session.profile.locale
  return getBrowserLocale()
}

/**
 * Guarda a escolha de idioma neste aparelho. Para quem não tem conta é a única persistência; para quem tem, o
 * perfil manda (ver getLocale) e o cookie só evita que o idioma mude no instante em que a pessoa sai da conta.
 * Só grava valor da lista: o cookie é lido de volta como confiável depois da validação em isLocale.
 */
export async function setLocaleCookie(locale: Locale): Promise<void> {
  if (!isLocale(locale)) return
  ;(await cookies()).set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: 'lax',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  })
}
