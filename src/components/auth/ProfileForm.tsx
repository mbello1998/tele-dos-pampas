'use client'

import { useRouter } from 'next/navigation'
import { useId, useState, useTransition } from 'react'
import { updateProfile } from '@/actions/profile'
import { safeNextPath } from '@/lib/auth/access'
import type { City, Country, Currency } from '@/lib/auth/types'
import { t, type Locale, type TranslationKey } from '@/lib/i18n'
import { formatMoney } from '@/lib/money/format'
import { errorClass, inputClass, labelClass, noticeClass, primaryButtonClass } from './ui'

export type ProfileFormValues = {
  fullName: string
  phone: string
  homeCity: City | ''
  locale: Locale
  currencyPref: Currency
}

const COUNTRY_OF: Record<City, Country> = { quarai: 'BR', artigas: 'UY' }
const CURRENCY_OF: Record<City, Currency> = { quarai: 'BRL', artigas: 'UYU' }
const PREVIEW_AMOUNT = 25

const ERROR_KEY: Record<'unauthenticated' | 'invalid' | 'forbidden' | 'failed', TranslationKey> = {
  unauthenticated: 'profile.error.forbidden',
  invalid: 'profile.error.invalid',
  forbidden: 'profile.error.forbidden',
  failed: 'profile.error.failed',
}

/**
 * Perfil: usado no onboarding e na tela de perfil. Idioma e moeda são dois campos independentes (um brasileiro
 * pode ver preços em pesos e um uruguaio em reais). A única ligação é uma sugestão no onboarding: escolher a
 * cidade propõe a moeda dela, e só se a pessoa ainda não mexeu na moeda.
 * O idioma escolhido aqui troca a própria tela na hora (e é o que vai para o perfil ao salvar).
 */
export function ProfileForm({
  initial,
  mode,
  next,
}: {
  initial: ProfileFormValues
  mode: 'onboarding' | 'settings'
  next?: string | null
}) {
  const router = useRouter()
  const ids = { name: useId(), phone: useId(), city: useId(), locale: useId(), currency: useId() }
  const [v, setV] = useState(initial)
  const [currencyTouched, setCurrencyTouched] = useState(mode === 'settings')
  const [error, setError] = useState<TranslationKey | null>(null)
  const [saved, setSaved] = useState(false)
  const [pending, start] = useTransition()
  const L = v.locale

  const set = <K extends keyof ProfileFormValues>(k: K, value: ProfileFormValues[K]) => {
    setSaved(false)
    setV((cur) => ({ ...cur, [k]: value }))
  }

  function submit(e: { preventDefault(): void }) {
    e.preventDefault()
    setError(null)
    setSaved(false)
    if (mode === 'onboarding' && !v.homeCity) return setError('profile.error.invalid')
    start(async () => {
      const r = await updateProfile({
        fullName: v.fullName,
        phone: v.phone.trim() === '' ? null : v.phone,
        locale: v.locale,
        currencyPref: v.currencyPref,
        ...(v.homeCity ? { homeCity: v.homeCity, country: COUNTRY_OF[v.homeCity] } : {}),
      })
      if (!r.ok) return setError(ERROR_KEY[r.error])
      if (mode === 'onboarding') return window.location.assign(safeNextPath(next))
      setSaved(true)
      router.refresh()
    })
  }

  return (
    <form onSubmit={submit} noValidate lang={L} className="space-y-5">
      {mode === 'onboarding' ? (
        <header>
          <h1 className="font-[family-name:var(--font-display)] text-4xl font-extrabold uppercase leading-none tracking-wide">
            {t('onboarding.title', L)}
          </h1>
          <p className="mt-3 text-base text-white/75">{t('onboarding.intro', L)}</p>
        </header>
      ) : null}
      <div>
        <label htmlFor={ids.name} className={labelClass}>
          {t('profile.name.label', L)}
        </label>
        <input
          id={ids.name}
          name="fullName"
          type="text"
          autoComplete="name"
          required
          maxLength={80}
          value={v.fullName}
          onChange={(e) => set('fullName', e.target.value)}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor={ids.city} className={labelClass}>
          {t('profile.city.label', L)}
        </label>
        <select
          id={ids.city}
          name="homeCity"
          value={v.homeCity}
          onChange={(e) => {
            const city = e.target.value as City | ''
            setSaved(false)
            setV((cur) => ({
              ...cur,
              homeCity: city,
              currencyPref: city && !currencyTouched ? CURRENCY_OF[city] : cur.currencyPref,
            }))
          }}
          className={inputClass}
        >
          <option value="" disabled>
            {'—'}
          </option>
          <option value="quarai">{t('city.quarai', L)}</option>
          <option value="artigas">{t('city.artigas', L)}</option>
        </select>
      </div>

      <div>
        <label htmlFor={ids.phone} className={labelClass}>
          {t('profile.phone.label', L)}
        </label>
        <input
          id={ids.phone}
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={v.phone}
          onChange={(e) => set('phone', e.target.value)}
          aria-describedby={`${ids.phone}-hint`}
          className={inputClass}
        />
        <p id={`${ids.phone}-hint`} className="mt-1.5 text-sm text-white/55">
          {t('profile.phone.hint', L)}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor={ids.locale} className={labelClass}>
            {t('profile.language.label', L)}
          </label>
          <select id={ids.locale} name="locale" value={v.locale} onChange={(e) => set('locale', e.target.value as Locale)} className={inputClass}>
            <option value="pt-BR">Português</option>
            <option value="es-UY">Español</option>
          </select>
        </div>
        <div>
          <label htmlFor={ids.currency} className={labelClass}>
            {t('profile.currency.label', L)}
          </label>
          <select
            id={ids.currency}
            name="currencyPref"
            value={v.currencyPref}
            onChange={(e) => {
              setCurrencyTouched(true)
              set('currencyPref', e.target.value as Currency)
            }}
            className={inputClass}
          >
            <option value="BRL">{t('currency.BRL', L)}</option>
            <option value="UYU">{t('currency.UYU', L)}</option>
          </select>
        </div>
      </div>

      <p className="text-sm text-white/65">
        {t('profile.currency.preview', L)}: <span className="preco font-semibold text-white" data-testid="currency-preview">{formatMoney(PREVIEW_AMOUNT, v.currencyPref, L)}</span>
      </p>

      <button type="submit" disabled={pending} className={primaryButtonClass}>
        {pending ? t('common.wait', L) : mode === 'onboarding' ? t('onboarding.submit', L) : t('profile.save', L)}
      </button>

      {error ? (
        <p role="alert" className={errorClass}>
          {t(error, L)}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className={noticeClass}>
          {t('profile.saved', L)}
        </p>
      ) : null}
    </form>
  )
}
