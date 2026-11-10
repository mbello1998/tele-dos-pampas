import type { Metadata } from 'next'
import { Landing } from '@/components/landing/Landing'
import { loadLandingContent } from '@/lib/landing/load'
import { display } from '@/lib/fonts'

// Server Component: lê os textos de `settings` no servidor e entrega HTML pronto. A página é
// estática e se refaz sozinha a cada 5 minutos, então editar um texto no Studio chega ao ar
// sem deploy.
export const revalidate = 300

export async function generateMetadata(): Promise<Metadata> {
  const content = await loadLandingContent('pt-BR')
  return { description: content.subheadline }
}

export default async function Home() {
  const content = await loadLandingContent('pt-BR')
  return (
    <div className={display.variable}>
      <Landing content={content} locale="pt-BR" />
    </div>
  )
}
