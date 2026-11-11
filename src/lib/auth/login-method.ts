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

export type LoginErrorKind =
  | 'invalid_identifier'
  | 'code_invalid'
  | 'rate_limited'
  | 'failed'
  /** Senha: e-mail e senha não batem, e a conta já existe. */
  | 'credentials'
  /** Senha: a conta foi criada mas o Supabase ainda exige confirmação por e-mail (chave "Confirm email"). */
  | 'confirm_still_on'

/** O campo do segundo campo: o código recebido, ou a senha. A tela lê daqui e não sabe qual dos dois é. */
export interface SecretField {
  inputType: 'text' | 'password'
  autoComplete: 'one-time-code' | 'current-password'
  inputMode: 'numeric' | 'text'
  labelKey: TranslationKey
  invalidKey: TranslationKey
  normalize(raw: string): string | null
}

export interface LoginMethod {
  kind: 'email' | 'phone' | 'password'
  /**
   * `false` = identificador e segredo na MESMA tela, sem nada enviado antes (senha). `true` = pede, envia,
   * confere (código). A tela lê este campo em vez de adivinhar pelo `kind`.
   */
  twoStep: boolean
  secret: SecretField
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
  twoStep: true,
  secret: {
    inputType: 'text',
    autoComplete: 'one-time-code',
    inputMode: 'numeric',
    labelKey: 'auth.code.label',
    invalidKey: 'auth.error.code_invalid',
    normalize: normalizeCode,
  },
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
  twoStep: true,
  secret: {
    inputType: 'text',
    autoComplete: 'one-time-code',
    inputMode: 'numeric',
    labelKey: 'auth.code.label',
    invalidKey: 'auth.error.code_invalid',
    normalize: normalizeCode,
  },
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

/** A senha mínima do Supabase é 6 caracteres; abaixo disso ele recusa e a mensagem dele não é para o usuário. */
const MIN_PASSWORD = 6

/**
 * SENHA, SEM CONFIRMAR E-MAIL. É um MODO DE TESTE, pedido pelo dono em 11/11/2026 para destravar o trabalho
 * enquanto o e-mail não entrega: o código por e-mail depende de templates e de um SMTP próprio, e nada disso
 * precisa estar de pé para experimentar as telas.
 *
 * O que ele troca, e é bom estar escrito: sem confirmação, qualquer pessoa cria conta com um e-mail que não é
 * dela. Para testar, tudo bem. Para abrir a praça, NÃO — antes disso, volte para `email` (ou `phone`) e ligue
 * de novo o "Confirm email" no Supabase.
 *
 * Uma tela só: entra quem já tem conta, e quem não tem é criado na hora, com a mesma senha digitada.
 */
export const passwordMethod: LoginMethod = {
  kind: 'password',
  twoStep: false,
  secret: {
    inputType: 'password',
    autoComplete: 'current-password',
    inputMode: 'text',
    labelKey: 'auth.password.label',
    invalidKey: 'auth.error.password_short',
    normalize: (raw) => (raw.length >= MIN_PASSWORD ? raw : null),
  },
  inputType: 'email',
  autoComplete: 'email',
  inputMode: 'email',
  labelKey: 'auth.email.label',
  introKey: 'auth.intro.password',
  invalidKey: 'auth.error.email_invalid',
  normalize: emailMethod.normalize,
  /** Nada é enviado: a tela de senha não tem etapa de envio. Existe só para o contrato fechar. */
  async sendCode() {
    return null
  },
  async verifyCode(supabase, email, password) {
    const entrar = await supabase.auth.signInWithPassword({ email, password })
    if (!entrar.error) return null
    if (isRateLimited(entrar.error)) return 'rate_limited'
    // Credencial errada pode ser "conta não existe": o Supabase não distingue de propósito, para não revelar
    // quem tem conta. Então tentamos criar — se a conta já existia, o cadastro falha e a senha estava errada.
    if (entrar.error.code !== 'invalid_credentials') return 'failed'

    const criar = await supabase.auth.signUp({ email, password })
    if (criar.error) {
      if (isRateLimited(criar.error)) return 'rate_limited'
      if (criar.error.code === 'weak_password') return 'invalid_identifier'
      // A conta já existia: então a senha é que estava errada.
      if (criar.error.code === 'user_already_exists') return 'credentials'
      return 'failed'
    }
    // Criou mas não entrou: o "Confirm email" continua ligado no painel e um e-mail acabou de sair. Sem esta
    // checagem a tela diria "entrou" e a pessoa cairia numa página sem sessão, sem entender nada.
    if (!criar.data.session) return 'confirm_still_on'
    return null
  },
}

/**
 * A chave única de troca. Valor desconhecido FALHA em vez de cair em e-mail em silêncio: um erro de digitação
 * na variável de ambiente não pode deixar o app no método errado sem ninguém notar.
 */
export function getLoginMethod(value: string | undefined = process.env.NEXT_PUBLIC_LOGIN_METHOD): LoginMethod {
  if (value === undefined || value === '' || value === 'email') return emailMethod
  if (value === 'phone') return phoneMethod
  if (value === 'password') return passwordMethod
  throw new Error(`NEXT_PUBLIC_LOGIN_METHOD inválido: "${value}" (use "email", "phone" ou "password")`)
}

/** Código de uso único digitado: 6 a 10 dígitos (o tamanho é configuração do projeto; hoje são 8). */
export function normalizeCode(raw: string): string | null {
  const v = raw.replace(/[\s-]/g, '')
  return /^[0-9]{6,10}$/.test(v) ? v : null
}
