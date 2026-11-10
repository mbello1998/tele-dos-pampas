import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AuthShell } from '@/components/auth/AuthShell'
import { LoginForm } from '@/components/auth/LoginForm'
import { postLoginPath, safeNextPath } from '@/lib/auth/access'
import { getSession } from '@/lib/auth/session'
import { t } from '@/lib/i18n'
import { getLocale } from '@/lib/i18n/server'

export const metadata: Metadata = { title: 'Tele dos Pampas', robots: { index: false } }

type Search = Promise<{ next?: string | string[] }>

export default async function Entrar({ searchParams }: { searchParams: Search }) {
  const { next: rawNext } = await searchParams
  const next = typeof rawNext === 'string' ? rawNext : undefined

  // Quem já entrou não vê o formulário: vai para onde iria depois de entrar.
  const session = await getSession()
  if (session) redirect(postLoginPath(session.profile, next))

  const locale = await getLocale()
  return (
    <AuthShell locale={locale} title={t('auth.title', locale)}>
      <LoginForm locale={locale} next={next ? safeNextPath(next, '') || null : null} />
    </AuthShell>
  )
}
