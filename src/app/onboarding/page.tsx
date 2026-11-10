import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AuthShell } from '@/components/auth/AuthShell'
import { ProfileForm } from '@/components/auth/ProfileForm'
import { LOGIN_PATH, PENDING_PATH, isOnboarded, safeNextPath } from '@/lib/auth/access'
import { getSession } from '@/lib/auth/session'
import { getBrowserLocale } from '@/lib/i18n/server'

export const metadata: Metadata = { title: 'Tele dos Pampas', robots: { index: false } }

type Search = Promise<{ next?: string | string[] }>

export default async function Onboarding({ searchParams }: { searchParams: Search }) {
  const { next: rawNext } = await searchParams
  const next = safeNextPath(typeof rawNext === 'string' ? rawNext : undefined)

  const session = await getSession()
  if (!session) redirect(`${LOGIN_PATH}?next=${encodeURIComponent('/onboarding')}`)
  if (session.profile.status !== 'active') redirect(PENDING_PATH)
  if (isOnboarded(session.profile)) redirect(next)

  // O `locale` do perfil de quem acabou de entrar é o padrão do banco, não uma escolha: o idioma sugerido vem
  // do cookie ou do navegador, e o que a pessoa confirmar aqui é gravado no perfil.
  const locale = await getBrowserLocale()
  return (
    <AuthShell locale={locale} showLocaleSwitch={false}>
      <ProfileForm
        mode="onboarding"
        next={next}
        initial={{ fullName: '', phone: '', homeCity: '', locale, currencyPref: session.profile.currencyPref }}
      />
    </AuthShell>
  )
}
