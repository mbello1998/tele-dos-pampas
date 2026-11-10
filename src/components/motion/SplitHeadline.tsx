import type { CSSProperties } from 'react'

type Props = {
  text: string
  as?: 'h1' | 'h2'
  className?: string
}

/**
 * Manchete que entra palavra por palavra. É um Server Component e o efeito é CSS puro
 * (src/styles/motion.css, dentro de `prefers-reduced-motion: no-preference`): roda no primeiro
 * quadro, sem esperar JavaScript nem piscar, e sem custo de bundle. Com reduced-motion a regra
 * nem se aplica e as palavras já estão visíveis.
 */
export function SplitHeadline({ text, as: Tag = 'h1', className }: Props) {
  const words = text.split(/\s+/).filter(Boolean)
  return (
    <Tag className={className}>
      {words.map((word, i) => (
        <span key={i}>
          <span className="palavra" style={{ '--i': i } as CSSProperties}>
            {word}
          </span>
          {i < words.length - 1 ? ' ' : null}
        </span>
      ))}
    </Tag>
  )
}
