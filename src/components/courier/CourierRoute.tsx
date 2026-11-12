'use client'

import dynamic from 'next/dynamic'
import { useMemo } from 'react'
import type { MapLabels } from '@/components/order/CourierMap'
import { remainingLine } from '@/lib/geo/route'
import { manobraSeguinte, proximaManobra } from '@/lib/geo/manobra'
import type { LatLng } from '@/lib/geo/types'
import { textoChegada, type Fix } from '@/lib/realtime/estimate'
import { useRastreio } from '@/lib/realtime/useRastreio'
import type { Locale } from '@/lib/money/format'
import type { CourierCopy } from './copy'
import type { Call } from './types'

/** O mapa do motoboy tem rótulos próprios: para ele, o pino é o cliente, não "seu endereço". */
const MAPA: Record<Locale, MapLabels> = {
  'pt-BR': { unavailable: 'Mapa indisponível', courier: 'Você', distance: 'a {m} do destino', showMap: 'Mostrar mapa', destination: 'O cliente' },
  'es-UY': { unavailable: 'Mapa no disponible', courier: 'Vos', distance: 'a {m} del destino', showMap: 'Mostrar mapa', destination: 'El cliente' },
}

const CourierMap = dynamic(() => import('@/components/order/CourierMap').then((m) => m.CourierMap), {
  ssr: false,
  loading: () => <div className="aspect-[4/3] w-full animate-pulse rounded-lg bg-superficie" aria-hidden />,
})

/**
 * O CAMINHO, na tela do motoboy. A mesma rota e a mesma conta que o cliente vê — de propósito: quando os dois
 * olham números diferentes, a conversa vira discussão, e quem perde é quem está na moto.
 *
 * A posição usada é a DELE, do GPS do próprio aparelho, não a que voltou do banco: é mais nova e não depende
 * do envio ter chegado. Por isso o mapa dele continua certo mesmo quando o sinal não está saindo — e é
 * exatamente aí que ele mais precisa saber para onde ir.
 */
export function CourierRoute({
  call,
  here,
  locale,
  copy,
}: {
  call: Call
  here: LatLng | null
  locale: Locale
  copy: CourierCopy
}) {
  // Antes de coletar, o destino é a coleta; depois, a entrega. O status manda, não o tipo do pedido.
  const indoColetar = call.status === 'aceito' || call.status === 'motoboy_chegou'
  const ponta = indoColetar ? call.pickup : call.dropoff
  const alvo = ponta.lat != null && ponta.lng != null ? { lat: ponta.lat, lng: ponta.lng } : null

  const fixes = useMemo<Fix[]>(() => (here ? [{ ...here, atMs: Date.now() }] : []), [here])
  const { rota, estimativa } = useRastreio(fixes, alvo)
  const adiante = useMemo(
    () => (rota && estimativa ? remainingLine(rota, rota.meters - estimativa.faltamMetros) : null),
    [rota, estimativa],
  )

  // Sem o ponto de entrega não há o que desenhar. Mas SEM O GPS DELE o mapa continua: o destino já é
  // metade da informação, e esconder a tela inteira enquanto o aparelho procura sinal é tirar o mapa
  // exatamente de quem acabou de aceitar a corrida e quer saber onde fica.
  if (!alvo) return null

  const endereco = [ponta.street, ponta.number].filter(Boolean).join(', ')
  const andados = rota && estimativa ? rota.meters - estimativa.faltamMetros : 0
  const instrucao = rota ? proximaManobra(rota, andados, locale) : null
  const depois = rota ? manobraSeguinte(rota, andados, locale) : null

  return (
    <div className="rounded-xl border border-borda bg-superficie p-3">
      <p className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-sm text-white/60">{indoColetar ? copy.from : copy.to}</span>
        {estimativa ? (
          <span className="preco text-base font-bold text-sol">{textoChegada(estimativa.faltamSegundos, locale)}</span>
        ) : null}
      </p>

      {/* A FAIXA DE NAVEGAÇÃO. Uma instrução por vez, grande, com a seguinte pequena embaixo — a dinâmica do
          Waze, e ela existe por um motivo físico: ninguém lê uma lista de dez passos a 40 km/h. O motoboy
          olha meio segundo no semáforo e tem de sair sabendo a próxima curva.
          Em cima da esquina a faixa acende: ali já não dá tempo de ler uma frase comprida. */}
      {instrucao && (
        <div
          className={`mb-2 rounded-lg border-l-4 px-3 py-2 ${
            instrucao.agora ? 'border border-sol bg-sol/20 border-l-sol' : 'border border-borda bg-poco border-l-rio'
          }`}
          data-manobra={instrucao.agora ? 'agora' : 'adiante'}
          aria-live="polite"
        >
          <p className={`${instrucao.agora ? 'text-xl' : 'text-lg'} font-extrabold leading-tight text-white`}>
            {instrucao.texto}
          </p>
          {depois ? <p className="mt-0.5 text-sm text-white/55">{locale === 'pt-BR' ? 'depois' : 'después'}: {depois}</p> : null}
        </div>
      )}
      {!here && (
        <p className="mb-2 text-sm text-white/60">
          {locale === 'pt-BR' ? 'Procurando o seu sinal para traçar o caminho…' : 'Buscando tu señal para trazar el camino…'}
        </p>
      )}
      <CourierMap
        tileUrlTemplate="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="© OpenStreetMap"
        courier={here ? { ...here } : null}
        destination={alvo}
        addressText={endereco}
        labels={MAPA[locale]}
        routeLine={rota?.line ?? null}
        aheadLine={adiante}
      />
    </div>
  )
}
