'use server'

import { redirect } from 'next/navigation'
import { postLoginPath } from '@/lib/auth/access'
import { getLoginMethod, type LoginErrorKind } from '@/lib/auth/login-method'
import { fetchOwnProfile } from '@/lib/auth/profile'
import { createClient } from '@/lib/supabase/server'

export type RequestCodeResult = { ok: true } | { ok: false; error: LoginErrorKind }
export type VerifyCodeResult = { ok: true; redirectTo: string } | { ok: false; error: LoginErrorKind }

/**
 * Pede o código de entrada. Serve para quem já tem conta e para quem está se cadastrando (`shouldCreateUser`):
 * não há tela de "criar conta". Toda a diferença entre e-mail e telefone mora em getLoginMethod().
 * Quem se cadastra vira `client` ativo por um trigger no banco; nada do que vem daqui escolhe papel.
 */
export async function requestCode(identifier: string): Promise<RequestCodeResult> {
  const method = getLoginMethod()
  const id = method.normalize(typeof identifier === 'string' ? identifier : '')
  if (!id) return { ok: false, error: 'invalid_identifier' }
  const error = await method.sendCode(await createClient(), id)
  return error ? { ok: false, error } : { ok: true }
}

/** Confere o código. Em sucesso a sessão fica nos cookies e devolve para onde a tela deve ir. */
export async function verifyCode(identifier: string, code: string, next?: string): Promise<VerifyCodeResult> {
  const method = getLoginMethod()
  const id = method.normalize(typeof identifier === 'string' ? identifier : '')
  if (!id) return { ok: false, error: 'invalid_identifier' }
  // Pelo descritor do método, nunca por normalizeCode direto: com senha o segredo não é um número de 6 dígitos,
  // e a tela não é a trava — esta é. Validar aqui com a regra errada recusaria toda senha válida.
  const token = method.secret.normalize(typeof code === 'string' ? code : '')
  if (!token) return { ok: false, error: method.twoStep ? 'code_invalid' : 'invalid_identifier' }

  const supabase = await createClient()
  const error = await method.verifyCode(supabase, id, token)
  if (error) return { ok: false, error }

  const { data } = await supabase.auth.getUser()
  const profile = data.user ? await fetchOwnProfile(supabase, data.user.id) : null
  if (!profile) return { ok: false, error: 'failed' }
  return { ok: true, redirectTo: postLoginPath(profile, next) }
}

export async function signOut(): Promise<void> {
  await (await createClient()).auth.signOut()
  redirect('/entrar')
}
