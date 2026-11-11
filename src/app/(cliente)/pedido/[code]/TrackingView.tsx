'use client'

// A tela que o cliente fica olhando enquanto espera. Tudo o que pode falhar tem uma saída que não derruba o
// resto: sem posição ainda, a timeline e um aviso; tiles fora do ar, o endereço em texto (o CourierMap cuida);
// canal em tempo real caído, consulta periódica; GPS do motoboy impreciso ou desligado, o pedido anda do mesmo
// jeito (a posição é um extra, o andamento vem de order_events).
import dynamic from 'next/dynamic'
import { useEffect, useMemo, useState } from 'react'
import { SearchingRadar } from '@/components/order/SearchingRadar'
import { StatusTimeline } from '@/components/order/StatusTimeline'
import type { Locale } from '@/lib/i18n'
import { isTrackingActive, subscribeToOrder, type EventRow, type PositionRow } from '@/lib/realtime/position'
import { trackingCopy } from './copy'
import type { TrackingData } from './data'

// O mapa só é baixado quando há posição para mostrar, e nunca no servidor.
const CourierMap = dynamic(() => import('@/components/order/CourierMap').then((m) => m.CourierMap), {
  ssr: false,
  loading: () => <div className="aspect-[4/3] w-full animate-pulse motion-reduce:animate-none rounded-lg bg-superficie" aria-hidden="true" />,
})

type Props = { data: TrackingData; locale: Locale }

const TERMINAL_OK = new Set(['entregue', 'finalizado'])

export function TrackingView({ data, locale }: Props) {
  const copy = trackingCopy(locale)
  const [events, setEvents] = useState<EventRow[]>(data.events)
  const [status, setStatus] = useState(data.status)
  const [position, setPosition] = useState<PositionRow | null>(data.position)
  const [degraded, setDegraded] = useState(false)

  useEffect(() => {
    // Pedido encerrado: nada a escutar.
    if (TERMINAL_OK.has(data.status) || data.status === 'cancelado') return
    return subscribeToOrder(data.code, (update) => {
      if (update.type === 'event') {
        setEvents((prev) => (prev.some((e) => e.id === update.event.id) ? prev : [...prev, update.event]))
        setStatus(update.event.to_status)
      } else if (update.type === 'position') {
        setPosition(update.position)
      } else {
        setDegraded(update.state === 'polling')
      }
    })
  }, [data.code, data.status])

  const active = isTrackingActive(status)
  const delivered = TERMINAL_OK.has(status)
  const cancelled = status === 'cancelado'
  // Depois da entrega ou do cancelamento a moto some da tela, mesmo que ainda houvesse uma posição na memória.
  const shownPosition = active ? position : null
  const searching = !delivered && !cancelled && !shownPosition && (status === 'aguardando_motoboy' || (data.kind === 'ride' && status === 'criado'))

  const fix = useMemo(
    () => (shownPosition ? { lat: shownPosition.lat, lng: shownPosition.lng, heading: shownPosition.heading, recordedAt: Date.parse(shownPosition.recorded_at) } : null),
    [shownPosition],
  )

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-6 px-4 py-6">
      <header>
        <p className="text-sm text-white/60">
          {copy.order} <span className="preco font-mono tracking-widest text-white" data-order-code>{data.code}</span>
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-display)] text-2xl font-extrabold uppercase tracking-wide text-sol" data-current-status>
          {copy.statusLabels[status] ?? status}
        </h1>
        {data.etaMinutes != null && active && (
          <p className="preco mt-1 text-sm text-white/70">
            {copy.eta}: {data.etaMinutes} min
          </p>
        )}
      </header>

      {degraded && (
        <p role="status" className="rounded-md border border-borda bg-superficie px-3 py-2 text-sm text-white/70" data-degraded>
          {copy.liveDegraded}
        </p>
      )}

      {searching && <SearchingRadar label={copy.searchingTitle} hint={copy.searchingHint} />}

      {active && fix && (
        <CourierMap
          tileUrlTemplate={data.tileUrl}
          attribution={data.attribution}
          courier={fix}
          destination={data.destination}
          addressText={data.dropoffText}
          labels={copy.map}
        />
      )}

      {active && !fix && (
        <section className="rounded-lg border border-borda bg-superficie p-4" data-waiting-signal>
          <p className="text-base font-semibold text-white">{copy.waitingSignal}</p>
          <p className="mt-1 text-sm text-white/60">{copy.waitingSignalHint}</p>
        </section>
      )}

      {delivered && <p className="text-lg font-semibold text-white">{copy.deliveredTitle}</p>}
      {cancelled && (
        <section>
          <p className="text-lg font-semibold text-brasa">{copy.cancelledTitle}</p>
          {data.cancelReason && (
            <p className="mt-1 text-sm text-white/70">
              {copy.cancelReason}: {data.cancelReason}
            </p>
          )}
        </section>
      )}

      {/* Endereços em texto: sempre presentes. É o que sobra quando mapa e posição não existem. */}
      <dl className="grid gap-3 text-sm" data-addresses>
        <div>
          <dt className="text-white/50">{copy.pickup}</dt>
          <dd className="text-base text-white">{data.pickupText}</dd>
        </div>
        <div>
          <dt className="text-white/50">{copy.dropoff}</dt>
          <dd className="text-base text-white">{data.dropoffText}</dd>
        </div>
      </dl>
      {data.crossesBorder && <p className="text-sm text-white/70">{copy.crossesBorder}</p>}

      <section aria-labelledby="timeline-title">
        <h2 id="timeline-title" className="mb-3 text-sm font-semibold uppercase tracking-wide text-white/50">
          {copy.timelineTitle}
        </h2>
        <StatusTimeline events={events} labels={copy.statusLabels} locale={locale} emptyLabel={copy.timelineEmpty} />
      </section>
    </main>
  )
}
