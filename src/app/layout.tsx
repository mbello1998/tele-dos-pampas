import type { Metadata } from 'next'
import './globals.css'
import { display, ui } from '@/lib/fonts'

export const metadata: Metadata = {
  title: 'Tele dos Pampas',
  description: 'Entregas e moto-táxi em Quaraí e Artigas.',
}

// As duas fontes são declaradas aqui, no documento, para valerem em toda rota: a de interface (Archivo) no
// corpo, a de display (Barlow Condensed) onde o componente pedir. Ambas são servidas pelo próprio Next.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`dark ${ui.variable} ${display.variable}`}>
      <body className="bg-noite font-[family-name:var(--font-ui)] text-white antialiased">{children}</body>
    </html>
  )
}
