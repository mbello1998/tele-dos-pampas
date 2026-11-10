import { resolve } from 'node:path'
import { config } from 'dotenv'
import { expect, type Page } from '@playwright/test'
import { connect } from '../../scripts/db/client'

config({ path: resolve(process.cwd(), '.env.local'), quiet: true })

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SECRET = process.env.SUPABASE_SECRET_KEY!
const adminHeaders = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }

export type TestUser = { id: string; email: string }
const created: TestUser[] = []

/**
 * Cria um usuário pelo caminho REAL do GoTrue (API de admin): é o supabase_auth_admin quem insere em auth.users,
 * então isto prova que o trigger on_auth_user_created dispara com o papel que o Supabase usa de verdade.
 * Nenhum e-mail é enviado.
 */
export async function createUser(tag: string): Promise<TestUser> {
  const email = `${tag}-${crypto.randomUUID().slice(0, 8)}@auth-e2e.invalid`
  const res = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ email, email_confirm: true }),
  })
  const j = await res.json()
  if (!res.ok) throw new Error(`createUser falhou: ${res.status} ${JSON.stringify(j).slice(0, 200)}`)
  const user = { id: j.id as string, email }
  created.push(user)
  return user
}

/**
 * Um código de uso único válido, obtido pela API de admin (generate_link NÃO envia e-mail). O teste digita esse
 * código na tela de verdade: o caminho de CONFERIR o código é real. O de PEDIR o código (signInWithOtp) não é
 * exercitado aqui de propósito: enviaria e-mail de verdade, com limite de envio e risco de rejeição.
 */
export async function otpFor(email: string): Promise<string> {
  const res = await fetch(`${URL_}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ type: 'magiclink', email }),
  })
  const j = await res.json()
  if (!res.ok || typeof j.email_otp !== 'string') throw new Error(`generate_link falhou: ${res.status}`)
  return j.email_otp
}

export async function withDb<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T> {
  const db = await connect()
  try {
    return await fn(async (sql, params) => (await db.query(sql, params)).rows)
  } finally {
    await db.end()
  }
}

/** Promove/rebaixa pelo banco, como o admin faria pelo Studio. */
export const setProfile = (id: string, set: { role?: string; status?: string; full_name?: string }) =>
  withDb(async (q) => {
    const cols = Object.keys(set)
    await q(`update public.profiles set ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`, [id, ...Object.values(set)])
  })

export const readProfile = (id: string) =>
  withDb(async (q) => (await q(`select role, status, full_name, locale, currency_pref, home_city, country, phone from public.profiles where id = $1`, [id]))[0])

/** Apaga o que o teste criou: usuário (o profile cai em cascata) e as linhas de auditoria que o cadastro gerou. */
export async function cleanupUsers() {
  const ids = created.map((u) => u.id)
  if (ids.length === 0) return
  for (const u of created) {
    await fetch(`${URL_}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: adminHeaders })
  }
  await withDb(async (q) => {
    await q(`delete from public.profiles where id = any($1::uuid[])`, [ids])
    await q(`delete from public.audit_log where table_name = 'profiles' and record_id = any($1::text[])`, [ids])
  })
  created.length = 0
}

export async function leftovers(ids: string[]) {
  return withDb(async (q) => ({
    users: (await q(`select count(*)::int n from auth.users where id = any($1::uuid[])`, [ids]))[0].n,
    profiles: (await q(`select count(*)::int n from public.profiles where id = any($1::uuid[])`, [ids]))[0].n,
    audit: (await q(`select count(*)::int n from public.audit_log where table_name = 'profiles' and record_id = any($1::text[])`, [ids]))[0].n,
  }))
}

/** Entra pela tela: "Já tenho um código" -> e-mail + código -> confirmar. Devolve quando a navegação terminou. */
export async function signInViaUi(page: Page, user: TestUser, opts: { next?: string; code?: string } = {}) {
  await page.goto(opts.next ? `/entrar?next=${encodeURIComponent(opts.next)}` : '/entrar')
  await page.getByRole('button', { name: /Já tenho um código|Ya tengo un código/ }).click()
  await page.getByLabel(/^(E-mail|Correo electrónico)$/).fill(user.email)
  await page.getByLabel(/^Código$/).fill(opts.code ?? (await otpFor(user.email)))
  await page.getByRole('button', { name: /Confirmar e (entrar|ingresar)/ }).click()
}

export { expect }
