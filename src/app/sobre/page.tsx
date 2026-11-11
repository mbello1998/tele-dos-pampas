// A landing institucional, que ANTES era `/`. Mudou de lugar porque a tela inicial passou a ser o pedido
// (um app de corrida abre no "para onde?", não numa manchete). Continua viva aqui, intacta, para quem chega
// por link de divulgação — status de WhatsApp, cartão, boca a boca.
import type { Metadata } from 'next'
import { Landing } from '@/components/landing/Landing'
import { loadLandingContent } from '@/lib/landing/load'
import { display } from '@/lib/fonts'

export const revalidate = 300

export async function generateMetadata(): Promise<Metadata> {
  const content = await loadLandingContent('pt-BR')
  return { description: content.subheadline, alternates: { languages: { 'es-UY': '/es' } } }
}

export default async function Sobre() {
  const content = await loadLandingContent('pt-BR')
  return (
    <div className={display.variable}>
      <Landing content={content} locale="pt-BR" />
    </div>
  )
}
