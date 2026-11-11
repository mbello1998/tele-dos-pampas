import { prefersReducedMotion } from './gsap'

/**
 * Levar a pessoa até a próxima pergunta, sozinho.
 *
 * Por que existe: num celular o formulário é mais alto que a tela. Escolher a rua abre o número e a referência
 * ABAIXO DA DOBRA; escolher a origem abre o destino abaixo da dobra. Quem não rolou acha que o app travou — e
 * essa é a reclamação mais comum de formulário em etapas.
 *
 * Duas regras:
 *   - com `prefers-reduced-motion` o salto é INSTANTÂNEO, não suave. Quem pediu menos movimento ainda precisa
 *     chegar lá: o que incomoda é o deslizar, não o destino;
 *   - no quadro seguinte (`requestAnimationFrame`), porque o trecho que acabou de aparecer ainda não tem a
 *     altura final no momento em que o efeito roda — rolar antes disso mira no lugar errado.
 *
 * Devolve a função de cancelamento, para o `useEffect` desfazer se a tela mudar antes do quadro chegar.
 */
export function rolarPara(el: Element | null, block: ScrollLogicalPosition = 'start'): () => void {
  if (!el || typeof window === 'undefined') return () => {}
  const behavior: ScrollBehavior = prefersReducedMotion() ? 'auto' : 'smooth'
  const id = requestAnimationFrame(() => el.scrollIntoView({ behavior, block }))
  return () => cancelAnimationFrame(id)
}
