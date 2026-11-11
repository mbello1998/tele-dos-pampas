// A TELA INICIAL é o pedido. Abrir o site é dizer para onde você vai e ver o preço — sem landing, sem porta
// de login, sem cadastro. A landing institucional mora em /sobre, para quem chega por link de divulgação.
//
// Server Component fino: idioma e moeda de exibição do servidor, e a ilha de cliente faz o resto. NÃO chama
// requireRole: esta tela é aberta a qualquer um, e a conta só aparece no confirmar.
import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { LocaleSwitch } from '@/components/auth/LocaleSwitch'
import { MeshBackdrop } from '@/components/request/MeshBackdrop'
import { REQUEST_COPY } from '@/components/request/copy'
import { RequestScreen } from '@/components/request/RequestScreen'
import { getSession } from '@/lib/auth/session'
import { getLocale } from '@/lib/i18n/server'

export const metadata: Metadata = {
  title: 'Tele dos Pampas — pedir uma corrida',
  description: 'Mototáxi e encomendas em Quaraí e Artigas. Veja o preço em reais e em pesos antes de criar conta.',
}

/**
 * A identidade numa imagem só: o pampa ao anoitecer, o sol enorme no horizonte e, embaixo, as duas malhas
 * urbanas separadas pelo rio e costuradas pela ponte, com um rastro âmbar numa rua. É o mesmo desenho que a
 * malha animada faz ao vivo — e é o que a pessoa vê no primeiro décimo de segundo. 32 kB no celular.
 */
const ARTE = '/arte/pampa-fundo-1536.webp'
/** Poster da malha, usado só como textura fraca atrás do formulário (ver MeshBackdrop). */
const POSTER_SRC = '/hero/poster-malha.svg'

export default async function Home() {
  const locale = await getLocale()
  // A moeda é preferência de quem tem conta; quem não tem vê em reais, com o total em pesos ao lado.
  const session = await getSession()
  const currency = session?.profile.currencyPref ?? 'BRL'
  const c = REQUEST_COPY[locale]

  return (
    <div lang={locale} className="relative min-h-[100svh] overflow-x-clip">
      {/* HERO. A arte ocupa a faixa de cima; a parte vazia dela (céu) é onde a marca e a manchete cabem sem
          disputar leitura, e o pé da imagem se dissolve no fundo para o formulário continuar sem costura. */}
      <header className="relative isolate">
        <div className="absolute inset-0 -z-10">
          <Image
            src={ARTE}
            alt=""
            fill
            priority
            sizes="(max-width: 768px) 100vw, 768px"
            className="object-cover object-bottom"
          />
          {/* Véu: escurece o topo (onde fica a marca) e o pé (onde o texto cai sobre a malha desenhada),
              e deixa o miolo — o sol e o rio — aparecer. Gradiente estático, sem custo por quadro. */}
          <div className="absolute inset-0 bg-[linear-gradient(to_bottom,rgba(11,15,13,0.62)_0%,rgba(11,15,13,0.12)_30%,rgba(11,15,13,0.55)_72%,var(--color-noite)_100%)]" />
        </div>

        {/* 44svh: a arte respira, e o primeiro serviço já aparece na primeira tela de um celular de 740 px.
            Mais alto que isso e a pessoa abre o app num cartaz, não num formulário. */}
        <div className="mx-auto flex min-h-[44svh] w-full max-w-[32rem] flex-col justify-between px-4 pb-5 pt-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-[family-name:var(--font-display)] text-lg font-extrabold uppercase tracking-wide">
              {c.brand}
            </span>
            <LocaleSwitch locale={locale} />
          </div>

          <div>
            <h1 className="font-[family-name:var(--font-display)] text-balance text-[clamp(2.5rem,12vw,3.75rem)] font-extrabold uppercase leading-[0.92] drop-shadow-[0_2px_12px_rgba(11,15,13,0.8)]">
              {c.headline}
            </h1>
            <p className="mt-2 max-w-sm text-base text-white/80">{c.sub}</p>
          </div>
        </div>
      </header>

      {/* O formulário. Atrás dele, a malha real das duas cidades como textura — a mesma geometria da arte,
          agora vinda do dataset de verdade, desenhando-se uma vez. Sem canvas, sem WebGL. */}
      <div className="relative">
        <MeshBackdrop posterSrc={POSTER_SRC} />
        <div className="mx-auto w-full max-w-[32rem] px-4 pb-6">
          <RequestScreen locale={locale} currency={currency} />

          <footer className="mt-8 grid gap-2 text-sm text-white/55">
            <p className="flex items-start gap-2">
              <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-rio" />
              <span>{c.hours}</span>
            </p>
            <Link href="/sobre" className="inline-flex min-h-11 items-center underline decoration-white/25 underline-offset-4">
              {c.about}
            </Link>
          </footer>
        </div>
      </div>
    </div>
  )
}
