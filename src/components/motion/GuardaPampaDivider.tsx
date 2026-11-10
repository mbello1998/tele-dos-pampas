import { ScrollReveal } from './ScrollReveal'

type Props = {
  /** Cor via utilitário de texto (text-sol, text-rio...): o motivo é uma máscara e herda currentColor. */
  className?: string
  /** Estende da esquerda para a direita ao entrar na tela. */
  reveal?: boolean
}

/** Divisor de seção com a guarda pampa. Decorativo: fora da árvore de acessibilidade. */
export function GuardaPampaDivider({ className = 'text-sol', reveal = false }: Props) {
  const strip = <div aria-hidden="true" className={`guarda-pampa ${className}`} />
  return reveal ? <ScrollReveal variant="draw">{strip}</ScrollReveal> : strip
}
