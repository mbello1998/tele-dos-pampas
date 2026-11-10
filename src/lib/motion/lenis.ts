// Rolagem suave. O Lenis só é baixado quando o movimento é permitido E o aparelho tem ponteiro
// fino (mouse ou trackpad): em tela de toque a rolagem nativa já é suave, e o Lenis seria só
// peso e uma rotina a mais por quadro num celular de entrada.
import { type Motion, prefersReducedMotion } from './gsap'

const noop = () => {}

export async function startSmoothScroll(motion: Motion | null): Promise<() => void> {
  if (!motion || typeof window === 'undefined') return noop
  if (prefersReducedMotion()) return noop
  if (!window.matchMedia('(pointer: fine)').matches) return noop

  const { default: Lenis } = await import(/* webpackChunkName: "lenis" */ 'lenis')
  const lenis = new Lenis({ autoRaf: false, anchors: true })
  // Um único relógio: o ticker do GSAP conduz o Lenis, e o Lenis avisa o ScrollTrigger.
  const tick = (time: number) => lenis.raf(time * 1000)
  lenis.on('scroll', motion.ScrollTrigger.update)
  motion.gsap.ticker.add(tick)
  motion.gsap.ticker.lagSmoothing(0)
  return () => {
    motion.gsap.ticker.remove(tick)
    lenis.destroy()
  }
}
