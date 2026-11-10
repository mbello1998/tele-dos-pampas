import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { signOut } from '@/actions/auth'
import { AuthShell } from '@/components/auth/AuthShell'
import { secondaryButtonClass, primaryButtonClass } from '@/components/auth/ui'
import { LOGIN_PATH, postLoginPath } from '@/lib/auth/access'
import { getSession } from '@/lib/auth/session'
import { t } from '@/lib/i18n'
import { getLocale } from '@/lib/i18n/server'
import { loadSupportPhone } from '@/lib/settings/support-phone'

export const metadata: Metadata = { title: 'Tele dos Pampas', robots: { index: false } }

/**
 * Tela de quem tem conta mas ainda não pode usar o app: cadastro `pending` (entregador, lojista ou frota à
 * espera da aprovação do admin) ou conta `blocked`. Sem ela essa pessoa veria um app vazio e ligaria para o dono.
 * O banco já lhes nega todo privilégio; a única coisa que elas leem é a própria linha de profiles, e é dela que
 * esta tela tira o status.
 */
export default async function Aguardando() {
  const session = await getSession()
  if (!session) redirect(LOGIN_PATH)
  if (session.profile.status === 'active') redirect(postLoginPath(session.profile))

  const locale = await getLocale()
  const blocked = session.profile.status === 'blocked'
  const phone = await loadSupportPhone()

  return (
    <AuthShell locale={locale} title={t(blocked ? 'blocked.title' : 'pending.title', locale)} intro={t(blocked ? 'blocked.body' : 'pending.body', locale)}>
      <div className="space-y-3" data-status={session.profile.status}>
        {phone ? (
          <a href={`https://wa.me/${phone}`} className={primaryButtonClass} rel="noopener">
            {t('support.whatsapp', locale)}
          </a>
        ) : null}
        {blocked ? null : (
          <a href="/aguardando" className={`${secondaryButtonClass} w-full`}>
            {t('pending.refresh', locale)}
          </a>
        )}
        <form action={signOut}>
          <button type="submit" className={`${secondaryButtonClass} w-full`}>
            {t('auth.signout', locale)}
          </button>
        </form>
      </div>
    </AuthShell>
  )
}
