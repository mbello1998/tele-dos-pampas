import type { Metadata } from 'next'
import Link from 'next/link'
import { requireRole } from '@/lib/auth/session'

export const metadata: Metadata = { title: 'Tele dos Pampas: admin', robots: { index: false } }

// Cada página sob /admin chama requireRole('admin') por conta própria: o middleware é a primeira barreira, esta
// chamada é a que decide, e o RLS é a que protege os dados de verdade. O despacho é a única tela de admin desta
// fatia, então a entrada é só o link para ela.
export default async function AdminHome() {
  await requireRole('admin', { next: '/admin' })
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-bold">Painel do admin</h1>
      <p className="mt-6">
        <Link href="/admin/despacho" className="underline underline-offset-4">
          Despacho de pedidos
        </Link>
      </p>
    </main>
  )
}
