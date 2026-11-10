// Carregador do GSAP. É a única porta de entrada: nenhum componente importa 'gsap' direto, para
// que ele nunca caia no bundle inicial. Quem não pode ou não deve ter movimento recebe `null`
// e o conteúdo fica como o servidor o entregou, completo e visível.
import type { gsap as Gsap } from 'gsap'
import type { ScrollTrigger as ScrollTriggerType } from 'gsap/ScrollTrigger'

export type Motion = { gsap: typeof Gsap; ScrollTrigger: typeof ScrollTriggerType }

type NetworkInformation = { saveData?: boolean; effectiveType?: string }

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Economia de dados ligada ou rede 2G: o público é de plano pré-pago, então nada decorativo. */
export function isConstrainedNetwork(): boolean {
  if (typeof navigator === 'undefined') return false
  const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection
  return Boolean(connection?.saveData) || connection?.effectiveType === 'slow-2g' || connection?.effectiveType === '2g'
}

/** O movimento decorativo está liberado neste aparelho? */
export function motionAllowed(): boolean {
  return typeof window !== 'undefined' && !prefersReducedMotion() && !isConstrainedNetwork()
}

let pending: Promise<Motion> | null = null

/**
 * Baixa GSAP e ScrollTrigger sob demanda, uma única vez. Devolve `null`, sem baixar nada, quando
 * o movimento não é permitido (reduced-motion, economia de dados, servidor).
 */
export function loadMotion(): Promise<Motion | null> {
  if (!motionAllowed()) return Promise.resolve(null)
  pending ??= Promise.all([
    import(/* webpackChunkName: "gsap" */ 'gsap'),
    import(/* webpackChunkName: "gsap-scrolltrigger" */ 'gsap/ScrollTrigger'),
  ]).then(([{ gsap }, { ScrollTrigger }]) => {
    gsap.registerPlugin(ScrollTrigger)
    return { gsap, ScrollTrigger }
  })
  return pending
}
