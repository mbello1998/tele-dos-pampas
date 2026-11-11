import type { CSSProperties } from 'react'
import type { LandingContent, Locale } from '@/lib/landing/content'
import { GuardaPampaDivider } from '@/components/motion/GuardaPampaDivider'
import { ScrollReveal } from '@/components/motion/ScrollReveal'
import { SmoothScroll } from '@/components/motion/SmoothScroll'
import { SplitHeadline } from '@/components/motion/SplitHeadline'
import { StreetGridDraw } from '@/components/motion/StreetGridDraw'

/** Poster estático do hero, gerado do dataset por scripts/landing/build-poster.ts. */
export const POSTER_SRC = '/hero/poster-malha.svg'

const display = 'font-[family-name:var(--font-display)]'
const delay = (seconds: number) => ({ '--delay': `${seconds}s` }) as CSSProperties

// A landing em português vive em /sobre desde que `/` passou a ser a tela de pedido; a espanhola, em /es.
const OTHER_LOCALE = {
  'pt-BR': { href: '/es', code: 'ES', lang: 'es-UY' },
  'es-UY': { href: '/sobre', code: 'PT', lang: 'pt-BR' },
} as const

/**
 * A landing. Nenhum texto daqui é escrito no componente: tudo vem de `content` (settings).
 * As únicas palavras fixas são a marca e os códigos de idioma e país.
 */
export function Landing({ content, locale }: { content: LandingContent; locale: Locale }) {
  const other = OTHER_LOCALE[locale]
  const services = [
    { copy: content.services.food, tone: 'text-sol' },
    { copy: content.services.courier, tone: 'text-rio' },
    { copy: content.services.ride, tone: 'text-white' },
  ]
  const phoneDigits = content.supportPhone?.replace(/\D/g, '') ?? ''

  return (
    <div lang={locale} className="overflow-x-clip">
      <SmoothScroll />

      <header className="absolute inset-x-0 top-0 z-10">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <span className={`${display} text-xl font-extrabold uppercase tracking-wide`}>Tele dos Pampas</span>
          <a
            href={other.href}
            hrefLang={other.lang}
            lang={other.lang}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-borda px-3 text-sm font-semibold tracking-wider text-white/90"
          >
            {other.code}
          </a>
        </div>
      </header>

      <main>
        {/* Hero. O fundo é um poster estático dentro de um quadro de tamanho fixo (data-hero-media):
            o vídeo da Fatia 6 entra nesse mesmo quadro, sem mexer no layout. */}
        <section className="relative isolate flex min-h-[100svh] flex-col justify-end overflow-hidden pb-14 pt-24">
          <div data-hero-media className="absolute inset-0 -z-10">
            {/* eslint-disable-next-line @next/next/no-img-element -- SVG estático, não há o que otimizar */}
            <img
              src={POSTER_SRC}
              alt=""
              width={1000}
              height={1000}
              decoding="async"
              className="h-full w-full object-cover opacity-40"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-noite via-noite/70 to-noite/10" />
          </div>

          <div className="mx-auto w-full max-w-6xl px-4">
            <SplitHeadline
              text={content.headline}
              className={`${display} max-w-4xl text-balance break-words text-[clamp(2.5rem,12vw,5.75rem)] font-extrabold uppercase leading-[0.92]`}
            />
            <p className="entra mt-5 max-w-xl text-lg text-white/85" style={delay(0.5)}>
              {content.subheadline}
            </p>
            <a
              href={content.ctaHref}
              className="entra mt-8 inline-flex min-h-12 items-center rounded-full bg-sol px-7 text-base font-bold text-noite"
              style={delay(0.65)}
            >
              {content.ctaLabel}
            </a>
            <p className="entra mt-6 flex max-w-xl items-start gap-2 text-sm text-white/75" style={delay(0.8)}>
              <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-rio" />
              <span>{content.hoursNotice}</span>
            </p>
          </div>
        </section>

        {/* A malha: as ruas reais, desenhadas. Fixada ao rolar em tela grande. */}
        <section data-pin className="relative flex items-center py-16 md:min-h-[100svh]">
          <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 md:grid-cols-2 md:items-center">
            <ScrollReveal>
              <h2 className={`${display} text-balance text-4xl font-extrabold uppercase leading-none sm:text-5xl`}>
                {content.gridTitle}
              </h2>
              <GuardaPampaDivider className="mt-5 max-w-40 text-sol" />
              <p className="mt-5 max-w-md text-lg text-white/80">{content.gridText}</p>
            </ScrollReveal>
            <div className="mx-auto w-full max-w-[min(100%,72svh)]">
              <StreetGridDraw
                posterSrc={POSTER_SRC}
                alt={content.gridAlt}
                labels={{ quarai: content.cityQuarai, artigas: content.cityArtigas, bridge: content.bridgeLabel }}
              />
            </div>
          </div>
        </section>

        <section id="como-funciona" className="mx-auto max-w-6xl scroll-mt-4 px-4 py-20">
          <ScrollReveal>
            <h2 className={`${display} text-balance text-4xl font-extrabold uppercase leading-none sm:text-5xl`}>
              {content.servicesTitle}
            </h2>
          </ScrollReveal>
          <GuardaPampaDivider reveal className="mt-5 text-rio" />
          <ScrollReveal as="ul" stagger className="mt-10 grid gap-4 md:grid-cols-3">
            {services.map(({ copy, tone }) => (
              <li key={copy.title} className="flex flex-col gap-4 bg-campo/25 p-5 pt-0">
                <GuardaPampaDivider className={`-mx-5 !w-[calc(100%+2.5rem)] ${tone}`} />
                <h3 className={`${display} text-2xl font-extrabold uppercase leading-none`}>{copy.title}</h3>
                <p className="text-white/80">{copy.text}</p>
              </li>
            ))}
          </ScrollReveal>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-24 pt-8">
          <GuardaPampaDivider reveal className="text-sol" />
          <ScrollReveal className="mt-12 max-w-2xl">
            <h2 className={`${display} text-balance text-4xl font-extrabold uppercase leading-none sm:text-5xl`}>
              {content.closingTitle}
            </h2>
            <div className="mt-8 flex flex-col items-start gap-5">
              <a
                href={content.ctaHref}
                className="inline-flex min-h-12 items-center rounded-full bg-sol px-7 text-base font-bold text-noite"
              >
                {content.ctaLabel}
              </a>
              {content.supportPhone && (
                <a
                  href={`https://wa.me/${phoneDigits}`}
                  className="flex min-h-11 flex-wrap items-center gap-x-3 text-white/85 underline decoration-white/30 underline-offset-4"
                >
                  <span>{content.supportLabel}</span>
                  <span className="font-semibold">{content.supportPhone}</span>
                </a>
              )}
            </div>
          </ScrollReveal>
        </section>
      </main>

      <footer className="mx-auto max-w-6xl px-4 pb-10">
        <p className={`${display} text-lg font-extrabold uppercase tracking-wide text-white/50`}>Tele dos Pampas</p>
      </footer>
    </div>
  )
}
