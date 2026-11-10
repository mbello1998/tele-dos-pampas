'use client'

import { useEffect, useRef, useState } from 'react'
import { GRID_VIEWBOX, type Mesh } from '@/lib/motion/grid-geometry'
import { loadMotion } from '@/lib/motion/gsap'
import { presets } from '@/lib/motion/presets'

type Props = {
  /** Poster estático (gerado a partir do mesmo dataset). É o que aparece sem JS, com reduced-motion e em rede lenta. */
  posterSrc: string
  alt: string
  labels: { quarai: string; artigas: string; bridge: string }
}

const DASH = 100 // pathLength dos traços: 100 = escondido, 0 = desenhado (ver presets.gridStroke)

/** Malha visual derivada do dataset por scripts/landing/build-grid.ts (poucos kB; o dataset cru tem 600 kB). */
const MESH_URL = '/data/grid-simplified.json'

async function fetchMesh(): Promise<Mesh> {
  const res = await fetch(MESH_URL)
  if (!res.ok) throw new Error(`malha: HTTP ${res.status}`)
  return res.json()
}

const hiddenStroke = { strokeDasharray: DASH, strokeDashoffset: DASH }

/**
 * A malha REAL das duas cidades se desenhando. A geometria vem do mesmo dataset da busca de
 * endereço (os datasets completos de cada cidade), reduzida em build para o que o olho vê na
 * escala da animação (public/data/grid-simplified.json). É buscada sob demanda quando a seção
 * está perto de entrar na tela, e só se o movimento for permitido. Antes disso, e sempre que
 * não for, o que se vê é o poster.
 *
 * Desktop: seção fixada, desenho amarrado à rolagem. Tela pequena: o desenho toca uma vez ao entrar.
 */
export function StreetGridDraw({ posterSrc, alt, labels }: Props) {
  const rootRef = useRef<HTMLElement>(null)
  const [mesh, setMesh] = useState<Mesh | null>(null)

  // 1) Buscar o dataset só quando a seção se aproxima, e só se o movimento for permitido.
  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    let cancelled = false

    const arm = async () => {
      const motion = await loadMotion()
      if (!motion || cancelled) return // reduced-motion, economia de dados: fica o poster
      try {
        const next = await fetchMesh()
        if (!cancelled) setMesh(next)
      } catch {
        // Sem a malha, o poster já mostra o desenho: nada a fazer.
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect()
          void arm()
        }
      },
      // Margem negativa: só busca quando o leitor já começou a rolar na direção da seção. Com margem
      // positiva, num celular a seção (logo abaixo do hero) já contaria como "perto" no carregamento.
      { rootMargin: '0px 0px -8% 0px' },
    )
    observer.observe(root)
    return () => {
      cancelled = true
      observer.disconnect()
    }
  }, [])

  // 2) Com a malha real na tela, montar a animação.
  useEffect(() => {
    const root = rootRef.current
    if (!mesh?.bridge || !root) return
    const { quarai: from, artigas: to } = mesh.bridge
    let cancelled = false
    let revert: (() => void) | undefined

    loadMotion().then((motion) => {
      if (!motion || cancelled) return
      const { gsap, ScrollTrigger } = motion
      const pick = (selector: string) => root.querySelector(selector)
      const poster = pick('[data-poster]')
      const quarai = pick('[data-quarai]')
      const artigas = pick('[data-artigas]')
      const river = pick('[data-river]')
      const bridge = pick('[data-bridge]')
      const dot = pick('[data-courier]')
      const cityLabels = root.querySelectorAll('[data-city-label]')
      const bridgeLabel = pick('[data-bridge-label]')
      if (!poster || !quarai || !artigas || !river || !bridge || !dot || !bridgeLabel) return

      const mm = gsap.matchMedia()
      revert = () => mm.revert()

      mm.add(
        {
          pinned: '(prefers-reduced-motion: no-preference) and (min-width: 768px)',
          once: '(prefers-reduced-motion: no-preference) and (max-width: 767px)',
        },
        (context) => {
          const pinned = Boolean(context.conditions?.pinned)
          const section = root.closest<HTMLElement>('[data-pin]') ?? root

          const tl = gsap.timeline({
            paused: !pinned,
            defaults: { overwrite: 'auto' },
            ...(pinned
              ? { scrollTrigger: { trigger: section, start: 'top top', end: '+=140%', scrub: 0.5, pin: true, anticipatePin: 1 } }
              : {}),
          })

          tl.to(poster, presets.posterDim.to, 0)
          tl.fromTo(quarai, presets.gridStroke.from, { ...presets.gridStroke.to, duration: 3 }, 0.2)
          tl.fromTo(river, presets.fade.from, { ...presets.fade.to, duration: 1 }, 1.2)
          tl.fromTo(artigas, presets.gridStroke.from, { ...presets.gridStroke.to, duration: 3 }, 1.8)
          tl.fromTo(cityLabels, presets.label.from, { ...presets.label.to, duration: 0.6, stagger: 0.8 }, 1.2)
          tl.fromTo(bridge, presets.gridStroke.from, { ...presets.gridStroke.to, duration: 0.8 }, 4.3)
          tl.fromTo(dot, presets.dot.from, { ...presets.dot.to, duration: 0.4 }, 5)
          // O entregador atravessa a ponte: só x e y (transform), sem tocar em cx/cy.
          tl.fromTo(dot, { x: 0, y: 0 }, { x: to.x - from.x, y: to.y - from.y, duration: 1.4, ease: 'power1.inOut' }, 5.2)
          tl.fromTo(bridgeLabel, presets.label.from, { ...presets.label.to, duration: 0.6 }, 5.2)

          if (pinned) {
            // O pin acrescenta altura à página: os gatilhos que vêm depois precisam recalcular.
            ScrollTrigger.refresh()
          } else {
            ScrollTrigger.create({ trigger: root, start: 'top 70%', once: true, onEnter: () => void tl.play() })
          }
        },
      )
    })

    return () => {
      cancelled = true
      revert?.()
    }
  }, [mesh])

  const bridge = mesh?.bridge ?? null

  return (
    <figure ref={rootRef} className="relative mx-auto aspect-square w-full" data-street-grid>
      {/* eslint-disable-next-line @next/next/no-img-element -- SVG estático, não há o que otimizar */}
      <img
        data-poster
        src={posterSrc}
        alt={alt}
        width={GRID_VIEWBOX}
        height={GRID_VIEWBOX}
        loading="lazy"
        decoding="async"
        className="absolute inset-0 h-full w-full"
      />

      {mesh && bridge && (
        <svg viewBox={`0 0 ${GRID_VIEWBOX} ${GRID_VIEWBOX}`} aria-hidden="true" className="absolute inset-0 h-full w-full">
          <path
            data-river
            d={mesh.river}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.22}
            strokeWidth={34}
            strokeLinecap="round"
            className="text-rio"
            style={{ opacity: 0 }}
          />
          <path
            data-quarai
            d={mesh.paths.quarai}
            pathLength={DASH}
            fill="none"
            stroke="currentColor"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-sol"
            style={hiddenStroke}
          />
          <path
            data-artigas
            d={mesh.paths.artigas}
            pathLength={DASH}
            fill="none"
            stroke="currentColor"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-rio"
            style={hiddenStroke}
          />
          <path
            data-bridge
            d={`M${bridge.quarai.x} ${bridge.quarai.y}L${bridge.artigas.x} ${bridge.artigas.y}`}
            pathLength={DASH}
            fill="none"
            stroke="currentColor"
            strokeWidth={6}
            strokeLinecap="round"
            className="text-white"
            style={hiddenStroke}
          />
          <circle data-courier cx={bridge.quarai.x} cy={bridge.quarai.y} r={11} fill="currentColor" className="text-sol" style={{ opacity: 0 }} />
        </svg>
      )}

      {/* Esmaece as bordas do quadro: a malha some no escuro em vez de ser cortada em linha reta.
          Gradiente estático por cima, sem máscara, que custaria repintura a cada quadro. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(closest-side,transparent_66%,var(--color-noite)_100%)]"
      />

      <figcaption className="pointer-events-none absolute inset-0 font-[family-name:var(--font-display)] uppercase tracking-wide">
        <span data-city-label className="absolute right-[3%] top-[5%] bg-noite/70 px-1.5 py-0.5 text-right text-xl font-extrabold leading-none text-sol sm:text-2xl">
          {labels.quarai} <span className="ml-1 text-xs text-white/70">BR</span>
        </span>
        <span data-city-label className="absolute bottom-[5%] left-[3%] bg-noite/70 px-1.5 py-0.5 text-xl font-extrabold leading-none text-rio sm:text-2xl">
          {labels.artigas} <span className="ml-1 text-xs text-white/70">UY</span>
        </span>
        <span
          data-bridge-label
          className="absolute left-1/2 top-1/2 ml-3 mt-4 bg-noite/70 px-1 text-xs leading-none tracking-widest text-white sm:text-sm"
        >
          {labels.bridge}
        </span>
      </figcaption>
    </figure>
  )
}
