// Decisões de acesso e de rota, puras (sem rede, sem next/headers): testáveis em Node e usáveis no middleware.
import type { ProfileLite } from './types'

export const LOGIN_PATH = '/entrar'
export const ONBOARDING_PATH = '/onboarding'
export const PENDING_PATH = '/aguardando'

export type AdminGate = { allow: true } | { allow: false; reason: 'anonymous' | 'inactive' | 'forbidden' }

/**
 * Quem passa por /admin/*. Só um `admin` com status `active`: é a mesma regra do banco (app_role() é nulo
 * para pending e blocked), então um admin bloqueado não entra nem na tela. O papel vem da linha de `profiles`
 * lida pelo banco, nunca de um claim do JWT (user_metadata é editável pelo usuário).
 */
export function adminGate(user: { id: string } | null, profile: ProfileLite | null): AdminGate {
  if (!user) return { allow: false, reason: 'anonymous' }
  if (!profile) return { allow: false, reason: 'forbidden' }
  if (profile.status !== 'active') return { allow: false, reason: 'inactive' }
  return profile.role === 'admin' ? { allow: true } : { allow: false, reason: 'forbidden' }
}

/**
 * Destino pós-login recebido na URL (`?next=`): só caminho do próprio site. Recusa `//host`, `/\host`, esquema,
 * caractere de controle (o navegador remove tab e quebra de linha, e `/\t/evil.com` viraria `//evil.com`) e o
 * próprio /entrar (laço). Qualquer coisa fora disso cai no `fallback`.
 */
export function safeNextPath(raw: unknown, fallback = '/'): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return fallback
  if (raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return fallback
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback
  const path = raw.split(/[?#]/, 1)[0]
  if (path === LOGIN_PATH || path.startsWith(`${LOGIN_PATH}/`)) return fallback
  return raw
}

/** Concluiu o onboarding: tem nome. É também o que separa "idioma escolhido" de "idioma padrão do banco". */
export const isOnboarded = (p: Pick<ProfileLite, 'fullName'>): boolean => (p.fullName ?? '').trim() !== ''

/** Para onde mandar quem acabou de entrar. */
export function postLoginPath(profile: ProfileLite, next?: unknown): string {
  if (profile.status !== 'active') return PENDING_PATH
  const target = safeNextPath(next)
  if (!isOnboarded(profile)) return target === '/' ? ONBOARDING_PATH : `${ONBOARDING_PATH}?next=${encodeURIComponent(target)}`
  return target
}
