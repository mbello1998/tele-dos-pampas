import type { Metadata } from 'next'
import { Landing } from '@/components/landing/Landing'
import { loadLandingContent } from '@/lib/landing/load'
import { display } from '@/lib/fonts'

// Mesma landing em espanhol (es-UY). Os textos vêm das mesmas chaves de `settings`.
export const revalidate = 300

export async function generateMetadata(): Promise<Metadata> {
  const content = await loadLandingContent('es-UY')
  return { description: content.subheadline, alternates: { languages: { 'pt-BR': '/' } } }
}

export default async function Inicio() {
  const content = await loadLandingContent('es-UY')
  return (
    <div className={display.variable}>
      <Landing content={content} locale="es-UY" />
    </div>
  )
}
