'use client'

import { useId, useState, useTransition } from 'react'
import { requestCode, verifyCode } from '@/actions/auth'
import { getLoginMethod, type LoginErrorKind } from '@/lib/auth/login-method'
import { t, type Locale, type TranslationKey } from '@/lib/i18n'
import { errorClass, inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from './ui'

const ERROR_KEY: Record<LoginErrorKind, TranslationKey | null> = {
  invalid_identifier: null, // depende do método: vem de method.invalidKey
  code_invalid: 'auth.error.code_invalid',
  rate_limited: 'auth.error.rate_limited',
  failed: 'auth.error.failed',
  credentials: 'auth.error.credentials',
  confirm_still_on: 'auth.error.confirm_still_on',
}

/**
 * Entrar em dois passos: identificador -> código. A tela só conhece o contrato de LoginMethod (rótulos, tipo do
 * input, normalização); se o método passar de e-mail para telefone, nada aqui muda.
 * "Já tenho um código" existe de propósito: quem sai para abrir o e-mail e volta pode ter perdido o estado da aba.
 */
export function LoginForm({ locale, next }: { locale: Locale; next: string | null }) {
  const method = getLoginMethod()
  const ids = { id: useId(), code: useId() }
  // Com senha não há o que enviar: a tela já nasce no formulário completo.
  const [step, setStep] = useState<'identifier' | 'code'>(method.twoStep ? 'identifier' : 'code')
  const [identifier, setIdentifier] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<TranslationKey | null>(null)
  const [pending, start] = useTransition()

  const errorFor = (kind: LoginErrorKind): TranslationKey => ERROR_KEY[kind] ?? method.invalidKey

  function send(e?: { preventDefault(): void }) {
    e?.preventDefault()
    setError(null)
    const normalized = method.normalize(identifier)
    if (!normalized) return setError(method.invalidKey)
    start(async () => {
      const r = await requestCode(normalized)
      if (!r.ok) return setError(errorFor(r.error))
      setIdentifier(normalized)
      setSentTo(normalized)
      setCode('')
      setStep('code')
    })
  }

  function confirm(e: { preventDefault(): void }) {
    e.preventDefault()
    setError(null)
    const normalized = method.normalize(identifier)
    if (!normalized) return setError(method.invalidKey)
    if (!method.secret.normalize(code)) return setError(method.secret.invalidKey)
    start(async () => {
      const r = await verifyCode(normalized, code, next ?? undefined)
      if (!r.ok) return setError(errorFor(r.error))
      // Navegação completa: a sessão acabou de entrar nos cookies e a página seguinte precisa nascer com ela.
      window.location.assign(r.redirectTo)
    })
  }

  const identifierField = (
    <div>
      <label htmlFor={ids.id} className={labelClass}>
        {t(method.labelKey, locale)}
      </label>
      <input
        id={ids.id}
        name="identifier"
        type={method.inputType}
        inputMode={method.inputMode}
        autoComplete={method.autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
        value={identifier}
        onChange={(e) => setIdentifier(e.target.value)}
        className={inputClass}
      />
    </div>
  )

  return (
    <>
      {step === 'identifier' ? (
        <form onSubmit={send} noValidate className="space-y-4">
          <p className="text-base text-white/75">{t(method.introKey, locale)}</p>
          {identifierField}
          <button type="submit" disabled={pending} className={primaryButtonClass}>
            {pending ? t('common.wait', locale) : t('auth.send', locale)}
          </button>
          <button
            type="button"
            onClick={() => {
              setError(null)
              setStep('code')
            }}
            className="block min-h-11 w-full text-center text-sm text-white/70 underline underline-offset-4"
          >
            {t('auth.code.have', locale)}
          </button>
        </form>
      ) : (
        <form onSubmit={confirm} noValidate className="space-y-4">
          {!method.twoStep ? <p className="text-base text-white/75">{t(method.introKey, locale)}</p> : null}
          {sentTo ? (
            <p className="text-base text-white/75">
              {t('auth.code.sent', locale)} <strong className="break-all text-white">{sentTo}</strong>
            </p>
          ) : null}
          {identifierField}
          <div>
            <label htmlFor={ids.code} className={labelClass}>
              {t(method.secret.labelKey, locale)}
            </label>
            <input
              id={ids.code}
              name={method.twoStep ? 'code' : 'password'}
              type={method.secret.inputType}
              inputMode={method.secret.inputMode}
              autoComplete={method.secret.autoComplete}
              enterKeyHint="go"
              required
              maxLength={method.twoStep ? 14 : 72}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className={`${inputClass} ${method.twoStep ? 'tracking-[0.3em]' : ''}`}
            />
          </div>
          <button type="submit" disabled={pending} className={primaryButtonClass}>
            {pending ? t('common.wait', locale) : t(method.twoStep ? 'auth.verify' : 'auth.enter', locale)}
          </button>
          <div className={`flex gap-3 ${method.twoStep ? '' : 'hidden'}`}>
            <button type="button" disabled={pending} onClick={() => send()} className={`${secondaryButtonClass} flex-1`}>
              {t('auth.resend', locale)}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setError(null)
                setStep('identifier')
              }}
              className={`${secondaryButtonClass} flex-1`}
            >
              {t('auth.back', locale)}
            </button>
          </div>
        </form>
      )}
      {error ? (
        <p role="alert" className={errorClass}>
          {t(error, locale)}
        </p>
      ) : null}
    </>
  )
}
