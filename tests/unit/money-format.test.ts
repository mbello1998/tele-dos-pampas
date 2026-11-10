import { convertBrlToUyu, formatMoney } from '@/lib/money/format'

describe('convertBrlToUyu', () => {
  test('aplica spread: 10 BRL a 7.80 com 5% vira 82 UYU', () => {
    expect(convertBrlToUyu(10, 7.8, 5)).toBe(82)
  })

  test('arredonda pesos para múltiplo de 1, sempre para cima', () => {
    // 1 BRL a 7.80 sem spread = 7.80 -> 8, nunca 7
    expect(convertBrlToUyu(1, 7.8, 0)).toBe(8)
    // 0.01 BRL a 7.80 = 0.078 -> 1
    expect(convertBrlToUyu(0.01, 7.8, 0)).toBe(1)
    // 10 BRL a 7.80 com 0% = 78 exato, não pode virar 79 por ruído de ponto flutuante
    expect(convertBrlToUyu(10, 7.8, 0)).toBe(78)
  })

  test('rejeita entradas não finitas ou taxa não positiva', () => {
    expect(() => convertBrlToUyu(Number.NaN, 7.8, 5)).toThrow(RangeError)
    expect(() => convertBrlToUyu(10, 0, 5)).toThrow(RangeError)
    expect(() => convertBrlToUyu(10, 7.8, Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })

  test('rejeita valor BRL negativo e spread que zera ou inverte a taxa', () => {
    expect(() => convertBrlToUyu(-10, 7.8, 5)).toThrow(RangeError)
    expect(() => convertBrlToUyu(10, 7.8, -100)).toThrow(RangeError)
    expect(() => convertBrlToUyu(10, 7.8, -150)).toThrow(RangeError)
  })
})

describe('formatMoney', () => {
  test('formatMoney pt-BR com BRL produz "R$ 15,00"', () => {
    expect(formatMoney(15, 'BRL', 'pt-BR')).toBe('R$ 15,00')
  })

  test('formatMoney es-UY com UYU produz "$U 117"', () => {
    expect(formatMoney(117, 'UYU', 'es-UY')).toBe('$U 117')
  })

  test('locale pt-BR com moeda UYU funciona: idioma e moeda são independentes', () => {
    expect(formatMoney(117, 'UYU', 'pt-BR')).toBe('$U 117')
  })

  test('locale es-UY com moeda BRL funciona: idioma e moeda são independentes', () => {
    expect(formatMoney(15, 'BRL', 'es-UY')).toBe('R$ 15,00')
  })

  test('separador de milhar e decimal segue o locale, símbolo é fixo por moeda', () => {
    expect(formatMoney(1234.5, 'BRL', 'pt-BR')).toBe('R$ 1.234,50')
    expect(formatMoney(1234.5, 'BRL', 'es-UY')).toBe('R$ 1.234,50')
    expect(formatMoney(1234, 'UYU', 'es-UY')).toBe('$U 1.234')
    expect(formatMoney(1234, 'UYU', 'pt-BR')).toBe('$U 1.234')
  })

  test('valor negativo põe o sinal antes do símbolo', () => {
    expect(formatMoney(-15, 'BRL', 'pt-BR')).toBe('-R$ 15,00')
  })

  test('rejeita valor não finito', () => {
    expect(() => formatMoney(Number.NaN, 'BRL', 'pt-BR')).toThrow(RangeError)
  })
})
