// PRÉVIA, SÓ EM DESENVOLVIMENTO. /loja/entrega exige sessão de `merchant` e o OTP por e-mail ainda não entrega
// código, então o dono não conseguiria olhar a tela que pediu. Esta rota monta o MESMO componente de verdade
// (ShopDeliveryScreen) com uma loja e endereços de exemplo, sem sessão.
//
// `notFound()` em produção, e nada aqui lê nem escreve no banco.
//
// O QUE ELA NÃO FAZ: o preço. quoteShopDelivery exige sessão de dono de loja ATIVO — é essa sessão que decide
// qual loja é dele e que o banco confere de novo (TD010). Sem login o preço não aparece, e isso é a trava
// funcionando, não um defeito. O desenho do campo de preço se avalia na tela do cliente, que é o mesmo
// PriceSummary. Apagar esta rota quando o login funcionar.
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { ShopDeliveryScreen, type SavedAddress, type ShopOption } from '@/components/shop/ShopDeliveryScreen'
import { ScreenBackdrop } from '@/components/shell/ScreenBackdrop'
import { SHOP_COPY } from '@/components/shop/copy'

export const metadata: Metadata = { title: 'Prévia: chamar motoboy', robots: { index: false, follow: false } }

const SHOPS: ShopOption[] = [{ id: '00000000-0000-0000-0000-0000000000a1', name: 'Tropical Lanches' }]

const SAVED: SavedAddress[] = [
  { id: '00000000-0000-0000-0000-0000000000b1', label: 'Dona Marli', summary: 'Rua Pedro Nolasco, 77' },
  { id: '00000000-0000-0000-0000-0000000000b2', label: 'Seu João (Promorar)', summary: 'Rua Vinte de Setembro, 1130' },
  { id: '00000000-0000-0000-0000-0000000000b3', label: 'Cerro do Ouro', summary: 'Rua Duque de Caxias, 1502' },
]

export default function PreviaLoja() {
  if (process.env.NODE_ENV === 'production') notFound()
  const locale = 'pt-BR' as const
  const c = SHOP_COPY[locale]

  return (
    <>
      <ScreenBackdrop name="loja" />
      <main lang={locale} className="mx-auto min-h-dvh w-full max-w-[32rem] px-4 pb-16 pt-5">
      <p className="mb-4 rounded-lg border border-sol/40 bg-sol/10 px-3 py-2 text-sm text-white/80">
        <strong className="font-semibold">Prévia.</strong> Loja e endereços de exemplo, sem login, só para avaliar
        o desenho. O <strong className="font-semibold">preço não vai aparecer aqui</strong>: ele só sai com sessão
        de dono de loja, porque é a sessão que prova de quem é a loja.
      </p>
      <header className="mb-5">
        <p className="font-[family-name:var(--font-display)] text-lg font-extrabold uppercase tracking-wide text-sol">
          Tele dos Pampas
        </p>
        <h1 className="font-[family-name:var(--font-display)] text-[clamp(2.25rem,11vw,3.25rem)] font-extrabold uppercase leading-[0.95]">
          {c.title}
        </h1>
        <p className="mt-2 text-base text-white/70">{c.sub}</p>
      </header>
      <ShopDeliveryScreen locale={locale} currency="BRL" shops={SHOPS} saved={SAVED} />
      </main>
    </>
  )
}
