import type { Metadata } from 'next'
import { requireRole } from '@/lib/auth/session'

export const metadata: Metadata = { title: 'Tele dos Pampas: admin', robots: { index: false } }

// Marcador da área do admin enquanto o console (Tarefa 13) não existe: dá ao middleware e ao requireRole uma
// página real para proteger. Cada página sob /admin chama requireRole('admin') por conta própria: o middleware
// é a primeira barreira, esta chamada é a que decide, e o RLS é a que protege os dados de verdade.
export default async function AdminHome() {
  await requireRole('admin', { next: '/admin' })
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-bold">Painel do admin</h1>
      <p className="mt-3 text-white/70">O console de despacho chega na Tarefa 13.</p>
    </main>
  )
}
