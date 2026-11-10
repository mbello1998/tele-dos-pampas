// Tradução da interface do app. Seguro para Server e Client Components (sem next/headers aqui).
// Detecção e persistência do idioma: ./detect (puro) e ./server (cookies, perfil).
import { DEFAULT_LOCALE, LOCALES, type Locale } from '@/lib/landing/content'
import { esUY } from './es-UY'
import { ptBR, type TranslationKey } from './pt-BR'

// O tipo Locale e a lista de idiomas têm uma só origem (a da landing); a interface do app reusa, não redefine.
export { DEFAULT_LOCALE, LOCALES }
export type { Locale }
export type { TranslationKey }

const TABLES: Record<Locale, Record<string, string>> = { 'pt-BR': ptBR, 'es-UY': esUY }

export const isLocale = (value: unknown): value is Locale =>
  typeof value === 'string' && (LOCALES as readonly string[]).includes(value)

const own = (table: Record<string, string>, key: string): string | undefined =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined

/**
 * O texto da chave no idioma pedido. Falta de tradução cai para pt-BR; chave desconhecida devolve a própria
 * chave (visível na tela e no teste), nunca derruba a página.
 */
export function t(key: TranslationKey, locale: Locale): string {
  const table = isLocale(locale) ? TABLES[locale] : TABLES[DEFAULT_LOCALE]
  return own(table, key) ?? own(ptBR, key) ?? key
}
