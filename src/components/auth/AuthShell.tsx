import Link from 'next/link'
import type { ReactNode } from 'react'
import { display } from '@/lib/fonts'
import type { Locale } from '@/lib/i18n'
import { LocaleSwitch } from './LocaleSwitch'
import { ScreenBackdrop } from '@/components/shell/ScreenBackdrop'

/**
 * Moldura das telas de conta. O idioma da tela vai em `lang` do bloco (o <html> do layout raiz é estático
 * para a landing continuar estática; ler cookie ali tornaria o site todo dinâmico).
 */
export function AuthShell({
  locale,
  title,
  intro,
  showLocaleSwitch = true,
  children,
}: {
  locale: Locale
  /** Sem título, quem usa a moldura desenha o próprio (o onboarding, cujo título acompanha o idioma do formulário). */
  title?: string
  intro?: string
  /** Telas com seletor de idioma próprio (onboarding, perfil) escondem o do cabeçalho para não haver dois. */
  showLocaleSwitch?: boolean
  children: ReactNode
}) {
  return (
    <>
      <ScreenBackdrop name="conta" />
      <div lang={locale} className={`${display.variable} min-h-[100svh]`}>
      <header className="mx-auto flex max-w-md items-center justify-between px-4 py-3">
        <Link href="/" className="font-[family-name:var(--font-display)] text-xl font-extrabold uppercase tracking-wide">
          Tele dos Pampas
        </Link>
        {showLocaleSwitch ? <LocaleSwitch locale={locale} /> : null}
      </header>
      <main className="mx-auto w-full max-w-md px-4 pb-16 pt-6">
        {title ? (
          <h1 className="font-[family-name:var(--font-display)] text-4xl font-extrabold uppercase leading-none tracking-wide">{title}</h1>
        ) : null}
        {intro ? <p className="mt-3 text-base text-white/75">{intro}</p> : null}
        <div className={title ? 'mt-6' : ''}>{children}</div>
      </main>
    </div>
    </>
  )
}
