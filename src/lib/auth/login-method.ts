// O método de login, isolado neste único módulo.
//
// Hoje: código de uso único por E-MAIL (o Supabase do projeto tem e-mail ligado e telefone desligado, porque
// SMS exige um provedor pago). É um expediente: numa cidade pequena de fronteira o entregador e o cliente
// vivem no celular e no WhatsApp, não no e-mail. A troca para telefone foi desenhada para ser só isto:
//   1. ligar o provedor de SMS no Supabase (configuração);
//   2. NEXT_PUBLIC_LOGIN_METHOD=phone (configuração);
//   3. as duas chamadas abaixo (signInWithOtp / verifyOtp com `phone`), que já estão escritas em phoneMethod.
// Nenhuma tela, nenhuma policy RLS, nenhum papel e nenhuma tabela dependem do método: as telas leem só os
// campos de `LoginMethod` (tipo de input, rótulos, normalização) e as Server Actions chamam sendCode/verifyCode.
// `profiles.phone` continua no modelo, anulável.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { TranslationKey } from '@/lib/i18n'

export type LoginErrorKind = 'invalid_identifier' | 'code_invalid' | 'rate_limited' | 'failed'

export interface LoginMethod {
  kind: 'email' | 'phone'
  /** Para o <input> da tela. */
  inputType: 'email' | 'tel'
  autoComplete: 'email' | 'tel'
  inputMode: 'email' | 'tel'
  labelKey: TranslationKey
  introKey: TranslationKey
  invalidKey: TranslationKey
  /** Texto digitado -> identificador canônico, ou null se não for válido. */
  normalize(raw: string): string | null
  /** Pede o código. Devolve null em sucesso, ou a categoria do erro (nunca o texto bruto do Supabase). */
  sendCode(supabase: SupabaseClient, identifier: string): Promise<LoginErrorKind | null>
  /** Confere o código. Em sucesso a sessão fica no cliente do Supabase. */
  verifyCode(supabase: SupabaseClient, identifier: string, code: string): Promise<LoginErrorKind | null>
}

type AuthErr = { code?: string; status?: number } | null

const RATE_LIMIT_CODES = new Set(['over_email_send_rate_limit', 'over_sms_send_rate_limit', 'over_request_rate_limit'])
const isRateLimited = (e: NonNullable<AuthErr>) => e.status === 429 || (e.code !== undefined && RATE_LIMIT_CODES.has(e.code))

function sendError(e: AuthErr): LoginErrorKind | null {
  if (!e) return null
  if (isRateLimited(e)) return 'rate_limited'
  if (e.code === 'email_address_invalid' || e.code === 'phone_number_invalid') return 'invalid_identifier'
  return 'failed'
}

function verifyError(e: AuthErr): LoginErrorKind | null {
  if (!e) return null
  if (isRateLimited(e)) return 'rate_limited'
  if (e.code === 'otp_expired' || e.code === 'validation_failed') return 'code_invalid'
  return 'failed'
}

const EMAIL_RE = /^[^\s@]+@[^\s@.][^\s@]*\.[^\s@.]+$/

export const emailMethod: LoginMethod = {
  kind: 'email',
  inputType: 'email',
  autoComplete: 'email',
  inputMode: 'email',
  labelKey: 'auth.email.label',
  introKey: 'auth.intro.email',
  invalidKey: 'auth.error.email_invalid',
  normalize(raw) {
    const v = raw.trim().toLowerCase()
    return v.length <= 254 && EMAIL_RE.test(v) ? v : null
  },
  async sendCode(supabase, email) {
    // Sem `options.data`: viraria user_metadata, que quem se cadastra controla. O papel nunca sai daqui.
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })
    return sendError(error)
  },
  async verifyCode(supabase, email, token) {
    const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' })
    return verifyError(error)
  },
}

export const phoneMethod: LoginMethod = {
  kind: 'phone',
  inputType: 'tel',
  autoComplete: 'tel',
  inputMode: 'tel',
  labelKey: 'auth.phone.label',
  introKey: 'auth.intro.phone',
  invalidKey: 'auth.error.phone_invalid',
  normalize(raw) {
    const digits = raw.replace(/[\s().-]/g, '').replace(/^\+/, '')
    return /^[0-9]{8,15}$/.test(digits) ? `+${digits}` : null
  },
  async sendCode(supabase, phone) {
    const { error } = await supabase.auth.signInWithOtp({ phone, options: { shouldCreateUser: true } })
    return sendError(error)
  },
  async verifyCode(supabase, phone, token) {
    const { error } = await supabase.auth.verifyOtp({ phone, token, type: 'sms' })
    return verifyError(error)
  },
}

/**
 * A chave única de troca. Valor desconhecido FALHA em vez de cair em e-mail em silêncio: um erro de digitação
 * na variável de ambiente não pode deixar o app no método errado sem ninguém notar.
 */
export function getLoginMethod(value: string | undefined = process.env.NEXT_PUBLIC_LOGIN_METHOD): LoginMethod {
  if (value === undefined || value === '' || value === 'email') return emailMethod
  if (value === 'phone') return phoneMethod
  throw new Error(`NEXT_PUBLIC_LOGIN_METHOD inválido: "${value}" (use "email" ou "phone")`)
}

/** Código de uso único digitado: 6 a 10 dígitos (o tamanho é configuração do projeto; hoje são 8). */
export function normalizeCode(raw: string): string | null {
  const v = raw.replace(/[\s-]/g, '')
  return /^[0-9]{6,10}$/.test(v) ? v : null
}
