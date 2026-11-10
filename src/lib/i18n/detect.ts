// Detecção de idioma pelo cabeçalho Accept-Language. Puro (sem next/headers): roda em teste e no middleware.
import { DEFAULT_LOCALE, type Locale } from './index'

/** Cookie do idioma escolhido por quem não tem conta (ou da última escolha neste aparelho). */
export const LOCALE_COOKIE = 'tdp_locale'
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

const MAX_ENTRIES = 32 // o cabeçalho vem do cliente: não vale processar megabytes de lixo

/**
 * Escolhe o idioma pelo maior q (empate: o primeiro da lista). Qualquer espanhol vira es-UY e qualquer
 * português vira pt-BR; nenhum suportado (ou q=0, ou lixo) cai no padrão.
 */
export function detectLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE
  let best: { locale: Locale; q: number } | null = null
  for (const part of acceptLanguage.split(',', MAX_ENTRIES)) {
    const [rawTag, ...params] = part.trim().split(';')
    const primary = rawTag.trim().toLowerCase().split('-')[0]
    const locale: Locale | null = primary === 'es' ? 'es-UY' : primary === 'pt' ? 'pt-BR' : null
    if (!locale) continue
    let q = 1
    for (const p of params) {
      const m = p.trim().match(/^q\s*=\s*([0-9.]+)$/i)
      if (m) q = Number(m[1])
    }
    if (!Number.isFinite(q) || q <= 0 || q > 1) continue
    if (!best || q > best.q) best = { locale, q }
  }
  return best?.locale ?? DEFAULT_LOCALE
}
