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
import { textoChegada, type Fix } from '@/lib/realtime/estimate'
import { useRastreio } from '@/lib/realtime/useRastreio'
import { remainingLine } from '@/lib/geo/route'
import { destinationFor } from './data'
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
  // O HISTÓRICO, não só a última. A velocidade média sai da diferença entre leituras, e é ela que faz o
  // marcador continuar andando quando o sinal cai. Com uma leitura só não há o que deduzir.
  const [fixes, setFixes] = useState<Fix[]>(() =>
    data.position ? [{ lat: data.position.lat, lng: data.position.lng, atMs: Date.parse(data.position.recorded_at) }] : [],
  )

  useEffect(() => {
    // Pedido encerrado: nada a escutar.
    if (TERMINAL_OK.has(data.status) || data.status === 'cancelado') return
    return subscribeToOrder(data.code, (update) => {
      if (update.type === 'event') {
        setEvents((prev) => (prev.some((e) => e.id === update.event.id) ? prev : [...prev, update.event]))
        setStatus(update.event.to_status)
      } else if (update.type === 'position') {
        setPosition(update.position)
        setFixes((prev) => {
          const novo = { lat: update.position.lat, lng: update.position.lng, atMs: Date.parse(update.position.recorded_at) }
          if (prev.length > 0 && prev[prev.length - 1].atMs >= novo.atMs) return prev // leitura repetida ou fora de ordem
          return [...prev, novo].slice(-12)
        })
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

  // O RASTREIO. Para onde o motoboy está indo depende de onde ele está no trabalho: antes de pegar, ele vem
  // buscar quem chamou; depois, os dois vão juntos para a entrega. Apontar sempre para a entrega mostraria o
  // caminho errado na metade da corrida.
  // Recalculado AQUI, com o status ao vivo: `destinationFor` é a mesma regra do servidor, mas o status dele
  // é o do carregamento da página. Quando o motoboy pega o passageiro, o alvo vira a entrega na hora.
  const alvo = active ? destinationFor(data.kind, status, data.pickup, data.dropoff) : null
  const { rota, estimativa } = useRastreio(fixes, alvo)
  const adiante = useMemo(
    () => (rota && estimativa ? remainingLine(rota, rota.meters - estimativa.faltamMetros) : null),
    [rota, estimativa],
  )
  // O marcador segue a estimativa, não a última leitura crua: é o que o faz andar pela rua e continuar
  // andando sem sinal. Sem rota ainda, cai na leitura crua.
  const marcador = estimativa ? { ...estimativa.posicao, heading: fix?.heading ?? null, recordedAt: Date.now() } : fix

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-6 px-4 py-6">
      <header>
        <p className="text-sm text-white/60">
          {copy.order} <span className="preco font-mono tracking-widest text-white" data-order-code>{data.code}</span>
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-display)] text-2xl font-extrabold uppercase tracking-wide text-sol" data-current-status>
          {copy.statusLabels[status] ?? status}
        </h1>
        {active && (estimativa || data.etaMinutes != null) && (
          <p className="preco mt-1 text-base text-white/80" data-eta>
            {copy.eta}:{' '}
            <strong className="font-bold text-white">
              {estimativa ? textoChegada(estimativa.faltamSegundos, locale) : `${data.etaMinutes} min`}
            </strong>
            {estimativa && estimativa.faltamMetros > 0 ? (
              <span className="text-white/55"> · {(estimativa.faltamMetros / 1000).toFixed(1)} km pela rua</span>
            ) : null}
          </p>
        )}
      </header>

      {degraded && (
        <p role="status" className="rounded-md border border-borda bg-superficie px-3 py-2 text-sm text-white/70" data-degraded>
          {copy.liveDegraded}
        </p>
      )}

      {/* O AVISO DE SINAL. Quando o celular do motoboy sai do ar, a tela continua andando por estimativa — e
          precisa DIZER isso. Rastreio que finge certeza é o que destrói a confiança: a pessoa desce para a
          calçada, não tem ninguém, e da próxima vez não acredita mais no aplicativo. */}
      {active && estimativa && estimativa.sinal !== 'ao_vivo' && (
        <p
          role="status"
          className={`rounded-lg border-l-4 px-3 py-2 text-sm ${
            estimativa.sinal === 'estimado'
              ? 'border border-rio/50 border-l-rio bg-rio/10 text-white'
              : 'border border-brasa/50 border-l-brasa bg-brasa/10 text-white'
          }`}
          data-signal={estimativa.sinal}
        >
          {estimativa.sinal === 'estimado' ? copy.signalEstimated : copy.signalLost}
        </p>
      )}

      {searching && <SearchingRadar label={copy.searchingTitle} hint={copy.searchingHint} />}

      {active && fix && (
        <CourierMap
          tileUrlTemplate={data.tileUrl}
          attribution={data.attribution}
          courier={marcador}
          destination={alvo}
          addressText={data.dropoffText}
          labels={copy.map}
          routeLine={rota?.line ?? null}
          aheadLine={adiante}
          estimated={estimativa?.sinal !== 'ao_vivo'}
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
