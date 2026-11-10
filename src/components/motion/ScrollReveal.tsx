'use client'

import { type ReactNode, useEffect, useRef } from 'react'
import { loadMotion } from '@/lib/motion/gsap'
import { presets } from '@/lib/motion/presets'

type Props = {
  children: ReactNode
  /** `reveal`: sobe e aparece. `draw`: estende da esquerda (divisor guarda pampa). */
  variant?: 'reveal' | 'draw'
  /** Anima os filhos diretos em sequência em vez do bloco inteiro. */
  stagger?: boolean
  as?: 'div' | 'section' | 'ul' | 'li'
  className?: string
}

/**
 * Entrada de bloco ao rolar a página. O HTML do servidor já traz o conteúdo visível; o estado
 * "escondido" só é aplicado pelo GSAP, e só quando o movimento é permitido. Sem JS, com
 * reduced-motion ou com economia de dados, o bloco simplesmente está lá.
 */
export function ScrollReveal({ children, variant = 'reveal', stagger = false, as: Tag = 'div', className }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let revert: (() => void) | undefined

    loadMotion().then((motion) => {
      const el = ref.current
      if (!motion || cancelled || !el) return
      const { gsap } = motion
      const mm = gsap.matchMedia()
      revert = () => mm.revert()
      // Só com movimento liberado. Se o usuário ligar reduced-motion no meio da sessão, o
      // matchMedia desfaz o tween e devolve o bloco ao estado original (visível).
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const preset = presets[variant]
        const targets = stagger ? Array.from(el.children) : el
        gsap.fromTo(targets, preset.from, {
          ...preset.to,
          ...(stagger ? { stagger: 0.09 } : {}),
          scrollTrigger: { trigger: el, start: 'top 88%', once: true },
        })
      })
    })

    return () => {
      cancelled = true
      revert?.()
    }
  }, [variant, stagger])

  const Element = Tag as 'div'
  return (
    <Element ref={ref} className={className}>
      {children}
    </Element>
  )
}
