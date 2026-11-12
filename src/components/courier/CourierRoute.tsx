'use client'

import dynamic from 'next/dynamic'
import { useMemo } from 'react'
import type { MapLabels } from '@/components/order/CourierMap'
import { remainingLine } from '@/lib/geo/route'
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

  if (!alvo || !here) return null

  const endereco = [ponta.street, ponta.number].filter(Boolean).join(', ')
  return (
    <div className="rounded-xl border border-borda bg-superficie p-3">
      <p className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-sm text-white/60">{indoColetar ? copy.from : copy.to}</span>
        {estimativa ? (
          <span className="preco text-base font-bold text-sol">{textoChegada(estimativa.faltamSegundos, locale)}</span>
        ) : null}
      </p>
      <CourierMap
        tileUrlTemplate="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution="© OpenStreetMap"
        courier={{ ...here }}
        destination={alvo}
        addressText={endereco}
        labels={MAPA[locale]}
        routeLine={rota?.line ?? null}
        aheadLine={adiante}
      />
    </div>
  )
}
