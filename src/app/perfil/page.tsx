import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { signOut } from '@/actions/auth'
import { AuthShell } from '@/components/auth/AuthShell'
import { ProfileForm } from '@/components/auth/ProfileForm'
import { secondaryButtonClass } from '@/components/auth/ui'
import { LOGIN_PATH, ONBOARDING_PATH, PENDING_PATH, isOnboarded } from '@/lib/auth/access'
import { getSession } from '@/lib/auth/session'
import { t } from '@/lib/i18n'
import { getLocale } from '@/lib/i18n/server'

export const metadata: Metadata = { title: 'Tele dos Pampas', robots: { index: false } }

export default async function Perfil() {
  const session = await getSession()
  if (!session) redirect(`${LOGIN_PATH}?next=${encodeURIComponent('/perfil')}`)
  if (session.profile.status !== 'active') redirect(PENDING_PATH)
  if (!isOnboarded(session.profile)) redirect(`${ONBOARDING_PATH}?next=${encodeURIComponent('/perfil')}`)

  const { profile, user } = session
  const locale = await getLocale()
  return (
    <AuthShell locale={locale} title={t('profile.title', locale)} showLocaleSwitch={false}>
      {user.email ? <p className="mb-6 break-all text-sm text-white/65" data-testid="account-email">{user.email}</p> : null}
      <ProfileForm
        mode="settings"
        initial={{
          fullName: profile.fullName ?? '',
          phone: profile.phone ?? '',
          homeCity: profile.homeCity ?? '',
          locale: profile.locale,
          currencyPref: profile.currencyPref,
        }}
      />
      <form action={signOut} className="mt-8">
        <button type="submit" className={`${secondaryButtonClass} w-full`}>
          {t('auth.signout', locale)}
        </button>
      </form>
    </AuthShell>
  )
}
