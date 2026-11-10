// Validação da entrada de updateProfile. Pura: a mesma função roda no teste e na Server Action.
//
// A entrada vem do navegador, ou seja, é não confiável. Só entram as colunas que o guard do banco
// (restrict_update_columns em profiles) deixa um usuário escrever: full_name, phone, locale, currency_pref,
// home_city, country. `role`, `status`, `id` e qualquer outra chave RECUSAM a chamada inteira (em vez de serem
// descartadas em silêncio): um campo privilegiado numa chamada é um erro, não algo a ignorar com educação.
// `locale` e `currencyPref` são independentes: cada um só vai para o patch se vier na entrada.
import { isLocale, type Locale } from '@/lib/i18n'
import type { City, Country, Currency } from '@/lib/auth/types'

export type ProfileInput = {
  fullName?: string
  phone?: string | null
  locale?: Locale
  currencyPref?: Currency
  homeCity?: City
  country?: Country
}

/** Colunas de `profiles` (snake_case) que o patch pode conter. */
export type ProfilePatch = {
  full_name?: string
  phone?: string | null
  locale?: Locale
  currency_pref?: Currency
  home_city?: City
  country?: Country
}

export type ParsedProfileInput = { ok: true; patch: ProfilePatch } | { ok: false; field: string }

const KNOWN = ['fullName', 'phone', 'locale', 'currencyPref', 'homeCity', 'country'] as const
const CURRENCIES: readonly Currency[] = ['BRL', 'UYU']
const CITIES: readonly City[] = ['quarai', 'artigas']
const COUNTRIES: readonly Country[] = ['BR', 'UY']

const fail = (field: string): ParsedProfileInput => ({ ok: false, field })

export function parseProfileInput(input: unknown): ParsedProfileInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail('input')
  const raw = input as Record<string, unknown>
  const keys = Object.keys(raw) // chaves próprias: `__proto__` vindo de JSON.parse aparece aqui e é recusada
  for (const k of keys) if (!(KNOWN as readonly string[]).includes(k)) return fail(k)
  if (keys.length === 0) return fail('input')

  const patch: ProfilePatch = {}
  for (const k of keys) {
    const v = raw[k]
    switch (k) {
      case 'fullName': {
        if (typeof v !== 'string') return fail(k)
        const name = v.trim()
        if (name.length < 1 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return fail(k)
        patch.full_name = name
        break
      }
      case 'phone': {
        if (v === null || v === '') {
          patch.phone = null
          break
        }
        if (typeof v !== 'string') return fail(k)
        const digits = v.replace(/[\s().-]/g, '').replace(/^\+/, '')
        if (!/^[0-9]{8,15}$/.test(digits)) return fail(k)
        patch.phone = `+${digits}`
        break
      }
      case 'locale':
        if (!isLocale(v)) return fail(k)
        patch.locale = v
        break
      case 'currencyPref':
        if (typeof v !== 'string' || !(CURRENCIES as readonly string[]).includes(v)) return fail(k)
        patch.currency_pref = v as Currency
        break
      case 'homeCity':
        if (typeof v !== 'string' || !(CITIES as readonly string[]).includes(v)) return fail(k)
        patch.home_city = v as City
        break
      case 'country':
        if (typeof v !== 'string' || !(COUNTRIES as readonly string[]).includes(v)) return fail(k)
        patch.country = v as Country
        break
    }
  }
  return { ok: true, patch }
}
