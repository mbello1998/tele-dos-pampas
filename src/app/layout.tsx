import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Tele dos Pampas',
  description: 'Entregas e moto-táxi em Quaraí e Artigas.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className="dark">
      <body className="bg-noite text-white antialiased">{children}</body>
    </html>
  )
}
