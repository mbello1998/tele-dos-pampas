import { describe, expect, test } from 'vitest'
import { parseProfileInput } from '@/lib/profile/input'

const ok = (input: unknown) => {
  const r = parseProfileInput(input)
  if (!r.ok) throw new Error(`esperava ok, veio erro em ${r.field}`)
  return r.patch
}
const bad = (input: unknown) => {
  const r = parseProfileInput(input)
  if (r.ok) throw new Error(`esperava erro, passou com ${JSON.stringify(r.patch)}`)
  return r.field
}

describe('parseProfileInput', () => {
  test('locale e currency_pref são independentes: cada um sozinho não arrasta o outro', () => {
    expect(ok({ locale: 'es-UY' })).toEqual({ locale: 'es-UY' })
    expect(ok({ currencyPref: 'UYU' })).toEqual({ currency_pref: 'UYU' })
    expect(Object.keys(ok({ locale: 'es-UY' }))).not.toContain('currency_pref')
    expect(Object.keys(ok({ currencyPref: 'UYU' }))).not.toContain('locale')
  })

  test.each([
    ['pt-BR', 'BRL'],
    ['pt-BR', 'UYU'],
    ['es-UY', 'BRL'],
    ['es-UY', 'UYU'],
  ] as const)('as quatro combinações são aceitas, inclusive as cruzadas: %s + %s', (locale, currencyPref) => {
    expect(ok({ locale, currencyPref })).toEqual({ locale, currency_pref: currencyPref })
  })

  test('valores fora do conjunto são recusados', () => {
    expect(bad({ locale: 'en-US' })).toBe('locale')
    expect(bad({ locale: 'es' })).toBe('locale')
    expect(bad({ currencyPref: 'USD' })).toBe('currencyPref')
    expect(bad({ currencyPref: 'brl' })).toBe('currencyPref')
    expect(bad({ locale: null })).toBe('locale')
  })

  test('campo privilegiado ou desconhecido recusa a chamada inteira, não é descartado em silêncio', () => {
    for (const field of ['role', 'status', 'id', 'created_at', 'is_admin', 'email']) {
      expect(bad({ [field]: 'x' }), field).toBe(field)
      expect(bad({ fullName: 'Ana', [field]: 'x' }), `${field} junto de um campo válido`).toBe(field)
    }
    expect(bad({ role: 'admin' })).toBe('role')
  })

  test('__proto__ como chave própria é recusado', () => {
    expect(bad(JSON.parse('{"__proto__": {"role": "admin"}, "fullName": "Ana"}'))).toBe('__proto__')
  })

  test('entrada que não é objeto, ou é vazia', () => {
    for (const v of [null, undefined, 'x', 3, ['locale'], true]) expect(bad(v)).toBe('input')
    expect(bad({})).toBe('input')
  })

  test('fullName: aparado, 1 a 80 caracteres, sem controle', () => {
    expect(ok({ fullName: '  Ana  Souza ' })).toEqual({ full_name: 'Ana  Souza' })
    expect(bad({ fullName: '' })).toBe('fullName')
    expect(bad({ fullName: '   ' })).toBe('fullName')
    expect(bad({ fullName: 'a'.repeat(81) })).toBe('fullName')
    expect(ok({ fullName: 'a'.repeat(80) })).toEqual({ full_name: 'a'.repeat(80) })
    expect(bad({ fullName: 'Ana\u0000' })).toBe('fullName')
    expect(bad({ fullName: 'Ana\nSouza' })).toBe('fullName')
    expect(bad({ fullName: 42 })).toBe('fullName')
    expect(ok({ fullName: 'Nuñez Piñeiro' })).toEqual({ full_name: 'Nuñez Piñeiro' })
  })

  test('phone: normaliza para +dígitos; vazio ou null limpa; lixo é recusado', () => {
    expect(ok({ phone: ' +55 (55) 99123-4567 ' })).toEqual({ phone: '+5555991234567' })
    expect(ok({ phone: '598 99 123 456' })).toEqual({ phone: '+59899123456' })
    expect(ok({ phone: '' })).toEqual({ phone: null })
    expect(ok({ phone: null })).toEqual({ phone: null })
    expect(bad({ phone: 'abc' })).toBe('phone')
    expect(bad({ phone: '123' })).toBe('phone')
    expect(bad({ phone: '1'.repeat(16) })).toBe('phone')
    expect(bad({ phone: 55 })).toBe('phone')
  })

  test('homeCity e country só aceitam o conjunto da fronteira', () => {
    expect(ok({ homeCity: 'quarai', country: 'BR' })).toEqual({ home_city: 'quarai', country: 'BR' })
    expect(ok({ homeCity: 'artigas', country: 'UY' })).toEqual({ home_city: 'artigas', country: 'UY' })
    expect(bad({ homeCity: 'Quaraí' })).toBe('homeCity')
    expect(bad({ homeCity: 'rivera' })).toBe('homeCity')
    expect(bad({ country: 'AR' })).toBe('country')
  })
})
