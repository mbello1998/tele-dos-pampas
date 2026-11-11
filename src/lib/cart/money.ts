// Dinheiro de VITRINE: o que o cliente vê antes de existir cotação. O preço cobrado vem do servidor (quote_order).
import { convertBrlToUyu, formatMoney } from '@/lib/money/format'
import type { Currency, DisplayFx, Locale } from './types'

// Mesmo saneamento do convertBrlToUyu: 6.25 * 8.8 = 55.00000000000001 não pode virar 56.
const trimFloatNoise = (x: number): number => Math.round(x * 1e6) / 1e6

/**
 * SEM CHAMADOR EM PRODUÇÃO HOJE, DE PROPÓSITO: não apague como código morto. Hoje todo peso exibido sai de
 * convertBrlToUyu (já com teto) ou do totalUyu do servidor, então nada precisa dele. Ele existe para o dia em que
 * alguém exibir um valor em pesos que NÃO passou por esses dois (uma soma, uma média, uma sobra calculada no
 * cliente): nesse caso use esta função, e não formatMoney direto.
 *
 * Por quê: formatMoney arredonda com Intl (meio para cima), então 81,4 pesos aparecem como "$U 81" quando o certo é 82.
 * Todo valor em pesos que NÃO passou por convertBrlToUyu (uma soma nossa, um valor fracionário) tem de passar por
 * aqui: os pesos sobem para o inteiro seguinte antes de exibir. Reais seguem inalterados.
 */
export function formatMoneyCeil(value: number, currency: Currency, locale: Locale): string {
  return formatMoney(currency === 'UYU' ? Math.ceil(trimFloatNoise(value)) : value, currency, locale)
}

/**
 * Valor em BRL no que será exibido. Em pesos usa convertBrlToUyu (spread e teto). Negativos (um price_delta que dá
 * desconto) arredondam em direção ao zero: nunca se promete mais desconto do que existe.
 */
export function toDisplayAmount(brl: number, currency: Currency, fx: DisplayFx): number {
  if (currency === 'BRL') return brl
  if (brl >= 0) return convertBrlToUyu(brl, fx.rate, fx.spreadPct)
  return Math.ceil(trimFloatNoise(brl * fx.rate * (1 + fx.spreadPct / 100)))
}

/**
 * Texto de um valor em BRL na moeda escolhida. Sem taxa (fx nulo) em pesos devolve reais com o símbolo R$:
 * jamais inventa um valor em pesos.
 */
export function formatDisplayMoney(brl: number, currency: Currency, locale: Locale, fx: DisplayFx | null): string {
  if (currency === 'UYU' && fx) return formatMoney(toDisplayAmount(brl, 'UYU', fx), 'UYU', locale)
  return formatMoney(brl, 'BRL', locale)
}
