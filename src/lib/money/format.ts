export type Currency = 'BRL' | 'UYU'
export type Locale = 'pt-BR' | 'es-UY'

// Símbolos fixos por moeda: o Intl do es-UY devolve "$" para UYU, e a cidade usa "$U".
const SYMBOL: Record<Currency, string> = { BRL: 'R$', UYU: '$U' }

// BRL mostra centavos; UYU não é cotado em centésimos.
const FRACTION_DIGITS: Record<Currency, number> = { BRL: 2, UYU: 0 }

// Remove ruído de ponto flutuante (ex.: 81.89999999999999 -> 81.9) antes de arredondar.
const trimFloatNoise = (x: number): number => Math.round(x * 1e6) / 1e6

const assertFinite = (name: string, value: number): void => {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} deve ser um número finito, recebido ${value}`)
  }
}

/**
 * Converte BRL em UYU aplicando o spread sobre a taxa (spreadPct = 5 significa taxa * 1.05)
 * e arredonda para o peso inteiro acima.
 */
export function convertBrlToUyu(brl: number, rate: number, spreadPct: number): number {
  assertFinite('brl', brl)
  assertFinite('rate', rate)
  assertFinite('spreadPct', spreadPct)
  if (brl < 0) {
    throw new RangeError(`brl não pode ser negativo, recebido ${brl}`)
  }
  if (rate <= 0) {
    throw new RangeError(`rate deve ser positiva, recebido ${rate}`)
  }

  const effectiveRate = rate * (1 + spreadPct / 100)
  if (effectiveRate <= 0) {
    throw new RangeError(`taxa efetiva com spread ${spreadPct}% deve ser positiva`)
  }

  return Math.ceil(trimFloatNoise(brl * effectiveRate))
}

/**
 * Formata um valor com o símbolo da moeda e os separadores do locale.
 * Idioma e moeda são independentes: ("UYU", "pt-BR") e ("BRL", "es-UY") são válidos.
 */
export function formatMoney(value: number, currency: Currency, locale: Locale): string {
  assertFinite('value', value)

  const digits = FRACTION_DIGITS[currency]
  const magnitude = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: 'always',
  }).format(Math.abs(value))

  // Sinal só aparece se o valor exibido for diferente de zero (evita "-R$ 0,00").
  const negative = value < 0 && /[1-9]/.test(magnitude)

  // Intl pode usar NBSP ou espaço estreito entre símbolo e número: normaliza para espaço comum.
  const text = `${SYMBOL[currency]} ${magnitude}`.replace(/\s/g, ' ')
  return negative ? `-${text}` : text
}
