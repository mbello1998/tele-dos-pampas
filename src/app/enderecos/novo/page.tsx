'use client'

// Cadastro de endereço. A página não exige sessão para ser exibida: quem decide se pode gravar é a Server
// Action (saveAddress), que recusa quem não entrou. Assim, quem ainda não entrou vê o formulário e a
// mensagem de falha, e não perde o que digitou por um redirecionamento no meio do preenchimento.
import Link from 'next/link'
import { useState } from 'react'
import type { Address } from '@/actions/addresses'
import { AddressForm } from '@/components/address/AddressForm'

export default function NovoEnderecoPage() {
  const [saved, setSaved] = useState<Address | null>(null)
  return (
    <main className="mx-auto grid max-w-xl gap-6 px-4 py-8">
      <h1 className="text-2xl font-extrabold">Novo endereço</h1>
      {saved ? (
        <div role="status" className="grid gap-3">
          <p className="text-base">
            Endereço salvo: <strong>{saved.label}</strong>
          </p>
          <Link href="/" className="min-h-11 text-base font-semibold underline">
            Voltar ao início
          </Link>
        </div>
      ) : (
        <AddressForm onDone={setSaved} />
      )}
    </main>
  )
}
