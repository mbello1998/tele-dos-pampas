'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { setLocale } from '@/actions/locale'
import { t, type Locale } from '@/lib/i18n'

// Nomes de cada idioma na própria língua: não se traduzem.
const OPTIONS: { locale: Locale; code: string; name: string }[] = [
  { locale: 'pt-BR', code: 'PT', name: 'Português' },
  { locale: 'es-UY', code: 'ES', name: 'Español' },
]

/** Troca o idioma: no perfil, se há conta ativa; no cookie, se não há. Não toca na moeda. */
export function LocaleSwitch({ locale }: { locale: Locale }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  return (
    <div role="group" aria-label={t('profile.language.label', locale)} className="flex gap-1.5">
      {OPTIONS.map((o) => (
        <button
          key={o.locale}
          type="button"
          lang={o.locale}
          aria-label={o.name}
          aria-pressed={o.locale === locale}
          disabled={pending}
          onClick={() => {
            if (o.locale === locale) return
            start(async () => {
              await setLocale(o.locale)
              router.refresh()
            })
          }}
          className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border px-3 text-sm font-semibold tracking-wider ${
            o.locale === locale ? 'border-sol bg-sol/15 text-sol' : 'border-borda text-white/80'
          }`}
        >
          {o.code}
        </button>
      ))}
    </div>
  )
}
