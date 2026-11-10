// Posição do motoboy: envio com limitador, canal por pedido e interpolação do marcador.
//
// Três peças independentes, todas testáveis sem navegador nem banco (tests/unit/interpolate.test.ts):
//   - publishPosition: o celular do motoboy, num suporte de guidão, com plano pré-pago. Manda a posição a cada
//     ~10 s OU 30 m, o que vier primeiro. Bateria e dados são custo real.
//   - subscribeToOrder: o cliente escuta o pedido. A privacidade NÃO é decidida aqui: o Realtime só entrega
//     linhas que a RLS deixa o assinante ler (migration 0025), então quem não é o cliente do pedido ativo
//     simplesmente não recebe nada.
//   - interpolatePosition / createMarkerAnimator: a moto desliza entre dois pontos em vez de teletransportar.
import type { SupabaseClient } from '@supabase/supabase-js'
import { haversineMeters } from '@/lib/geo/distance'
import type { LatLng } from '@/lib/geo/types'

// ---------------------------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------------------------
export const POSITION_MIN_INTERVAL_MS = 10_000
export const POSITION_MIN_DISTANCE_M = 30
/** Um fix pior que isso (GPS impreciso, dentro de casa, no túnel) não vale o dado que gasta. */
export const POSITION_MAX_ACCURACY_M = 100

/**
 * Status em que o cliente acompanha o motoboy no mapa. É lista POSITIVA, espelho exato do que a policy do
 * banco aceita (private.client_may_track, 0025): um status novo no enum nasce invisível até alguém
 * classificá-lo de propósito. tests/db/position-privacy.test.ts compara as duas pontas.
 */
export const TRACKING_ACTIVE_STATUSES = [
  'em_preparo',
  'pronto',
  'aceito',
  'motoboy_chegou',
  'coletado',
  'em_rota',
  'em_viagem',
] as const
export type TrackingStatus = (typeof TRACKING_ACTIVE_STATUSES)[number]

export const isTrackingActive = (status: string): status is TrackingStatus =>
  (TRACKING_ACTIVE_STATUSES as readonly string[]).includes(status)

// ---------------------------------------------------------------------------------------------
// Interpolação
// ---------------------------------------------------------------------------------------------
/**
 * Ponto entre `from` e `to`. Interpolação linear em latitude e longitude: para trechos de dezenas de metros
 * (o intervalo entre dois fixes) o erro frente à geodésica é desprezível. `t` é limitado a [0, 1]; inválido
 * (NaN) fica na origem.
 */
export function interpolatePosition(from: LatLng, to: LatLng, t: number): LatLng {
  if (!Number.isFinite(t) || t <= 0) return { lat: from.lat, lng: from.lng }
  if (t >= 1) return { lat: to.lat, lng: to.lng }
  return { lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t }
}

/** Rumo de `from` para `to`, em graus de 0 (norte) a 360, sentido horário. */
export function bearingDegrees(from: LatLng, to: LatLng): number {
  const rad = Math.PI / 180
  const dLng = (to.lng - from.lng) * rad
  const y = Math.sin(dLng) * Math.cos(to.lat * rad)
  const x = Math.cos(from.lat * rad) * Math.sin(to.lat * rad) - Math.sin(from.lat * rad) * Math.cos(to.lat * rad) * Math.cos(dLng)
  return ((Math.atan2(y, x) / rad) % 360 + 360) % 360
}

/**
 * Quanto tempo o marcador leva para ir de um fix ao seguinte: o intervalo real entre os dois (o cliente vê a
 * moto com um fix de atraso, andando sempre), limitado para não piscar nem arrastar por minutos quando o
 * motoboy ficou sem sinal. Sem referência utilizável, o ritmo de envio.
 */
export function glideDurationMs(previousAtMs: number | undefined, nextAtMs: number): number {
  const MIN = 1_000
  const MAX = 12_000
  if (previousAtMs === undefined || !Number.isFinite(previousAtMs) || !Number.isFinite(nextAtMs)) return POSITION_MIN_INTERVAL_MS
  const gap = nextAtMs - previousAtMs
  if (gap < 0) return POSITION_MIN_INTERVAL_MS
  return Math.min(MAX, Math.max(MIN, gap))
}

export type MarkerAnimator = {
  /** Anima da posição ATUAL do marcador (não da anterior) até `to`. `durationMs` 0 vai direto. */
  moveTo(to: LatLng, durationMs: number): void
  /** Onde o marcador está agora (null antes do primeiro ponto). */
  current(): LatLng | null
  stop(): void
}

type AnimatorOptions = {
  onFrame: (position: LatLng) => void
  raf?: (cb: (ts: number) => void) => number
  caf?: (id: number) => void
  now?: () => number
}

/**
 * Anima o marcador com requestAnimationFrame. Quem chama aplica a posição como `transform` (nunca como
 * left/top): só compositor, sem layout. Três garantias:
 *   - nunca teleporta: um ponto novo no meio de um deslize parte de onde o marcador está AGORA;
 *   - o primeiro ponto aparece onde está (não há de onde deslizar) e `durationMs` 0 (movimento reduzido) vai
 *     direto, sem agendar quadro nenhum;
 *   - termina exatamente no ponto, sem sobra de arredondamento.
 */
export function createMarkerAnimator(opts: AnimatorOptions): MarkerAnimator {
  const raf = opts.raf ?? ((cb) => requestAnimationFrame(cb))
  const caf = opts.caf ?? ((id) => cancelAnimationFrame(id))
  const now = opts.now ?? (() => performance.now())
  let shown: LatLng | null = null
  let frame: number | null = null

  const cancel = () => {
    if (frame !== null) caf(frame)
    frame = null
  }
  const show = (p: LatLng) => {
    shown = p
    opts.onFrame(p)
  }

  return {
    moveTo(to, durationMs) {
      cancel()
      if (shown === null || !(durationMs > 0)) {
        show(to)
        return
      }
      const from = shown
      const startedAt = now()
      const step = (ts: number) => {
        const t = (ts - startedAt) / durationMs
        if (t >= 1) {
          frame = null
          show(to)
          return
        }
        show(interpolatePosition(from, to, t))
        frame = raf(step)
      }
      frame = raf(step)
    },
    current: () => shown,
    stop: cancel,
  }
}

// ---------------------------------------------------------------------------------------------
// Envio com limitador
// ---------------------------------------------------------------------------------------------
export type PositionFix = LatLng & { heading?: number | null; accuracy_m?: number | null }
export type PositionSender = (orderId: string, fix: PositionFix) => Promise<void>
export type PublishResult = 'sent' | 'failed' | 'throttled' | 'inaccurate' | 'busy'

type PublisherOptions = {
  now?: () => number
  minIntervalMs?: number
  minDistanceM?: number
  maxAccuracyM?: number
}

/**
 * Cria o limitador. Regras, na ordem:
 *   1. fix com acurácia pior que `maxAccuracyM` é ignorado e NÃO ocupa a vez (o próximo fix bom é enviado);
 *   2. um envio em andamento não abre um segundo (`busy`);
 *   3. o primeiro fix, ou o primeiro de um pedido novo, envia na hora;
 *   4. depois, envia se passaram `minIntervalMs` OU se andou `minDistanceM` desde o último envio. A distância
 *      é contada do último ponto ENVIADO, então andar devagar também acaba cruzando os 30 m;
 *   5. a TENTATIVA conta, tenha dado certo ou não: sem rede, o aparelho tenta a cada 10 s em vez de a cada
 *      segundo do GPS, que é o que esvaziaria a bateria sem trazer nada.
 * O relógio que andou para trás (ajuste de hora do celular) não trava o envio.
 */
export function createPositionPublisher(send: PositionSender, options: PublisherOptions = {}) {
  const now = options.now ?? (() => performance.now())
  const minInterval = options.minIntervalMs ?? POSITION_MIN_INTERVAL_MS
  const minDistance = options.minDistanceM ?? POSITION_MIN_DISTANCE_M
  const maxAccuracy = options.maxAccuracyM ?? POSITION_MAX_ACCURACY_M
  let last: { orderId: string; at: number; pos: LatLng } | null = null
  let inFlight = false

  return {
    async publish(orderId: string, fix: PositionFix): Promise<PublishResult> {
      if (fix.accuracy_m != null && fix.accuracy_m > maxAccuracy) return 'inaccurate'
      if (inFlight) return 'busy'
      const at = now()
      if (last && last.orderId === orderId) {
        const elapsed = at - last.at
        const due = elapsed < 0 || elapsed >= minInterval || haversineMeters(last.pos, fix) >= minDistance
        if (!due) return 'throttled'
      }
      last = { orderId, at, pos: { lat: fix.lat, lng: fix.lng } }
      inFlight = true
      try {
        await send(orderId, fix)
        return 'sent'
      } catch {
        return 'failed'
      } finally {
        inFlight = false
      }
    },
    /** Esquece o último envio (fim de turno): o próximo fix sai na hora. */
    reset() {
      last = null
    },
  }
}

// O cliente do Supabase é carregado sob demanda: este módulo é importado por testes e por telas que não
// precisam dele, e a camada de sessão é da Tarefa 8.
async function browserClient(): Promise<SupabaseClient> {
  const mod = (await import('@/lib/supabase/client')) as { createClient: () => SupabaseClient }
  return mod.createClient()
}

async function insertPosition(orderId: string, fix: PositionFix): Promise<void> {
  const client = await browserClient()
  const { data } = await client.auth.getUser()
  const courierId = data.user?.id
  if (!courierId) throw new Error('sem sessão')
  const { error } = await client.from('courier_positions').insert({
    courier_id: courierId,
    order_id: orderId,
    lat: round6(fix.lat),
    lng: round6(fix.lng),
    heading: fix.heading == null ? null : Math.round(fix.heading * 100) / 100,
    accuracy_m: fix.accuracy_m == null ? null : Math.round(fix.accuracy_m * 100) / 100,
  })
  // A RLS recusa a linha de quem não carrega o pedido (42501): é erro de verdade, não "tente de novo".
  if (error) throw new Error(error.message)
}
const round6 = (n: number) => Math.round(n * 1e6) / 1e6

let defaultPublisher: ReturnType<typeof createPositionPublisher> | null = null

/**
 * Envia a posição do motoboy para o pedido, no máximo a cada ~10 s ou 30 m. Chame a cada fix do
 * watchPosition; o limitador decide se sai. Nunca lança.
 */
export function publishPosition(orderId: string, pos: PositionFix): Promise<PublishResult> {
  defaultPublisher ??= createPositionPublisher(insertPosition)
  return defaultPublisher.publish(orderId, pos)
}
export function resetPositionPublisher() {
  defaultPublisher?.reset()
}

// ---------------------------------------------------------------------------------------------
// Canal por pedido (cliente)
// ---------------------------------------------------------------------------------------------
export type PositionRow = { lat: number; lng: number; heading: number | null; accuracy_m: number | null; recorded_at: string }
export type EventRow = { id: number; from_status: string | null; to_status: string; created_at: string }
export type OrderUpdate =
  | { type: 'position'; position: PositionRow }
  | { type: 'event'; event: EventRow }
  /** O canal em tempo real caiu: a tela passa a consultar de tempos em tempos até ele voltar. */
  | { type: 'connection'; state: 'live' | 'polling' }

type SubscribeOptions = { client?: SupabaseClient; pollMs?: number }

const num = (v: unknown): number => Number(v)
function toPosition(r: Record<string, unknown>): PositionRow {
  return {
    lat: num(r.lat),
    lng: num(r.lng),
    heading: r.heading == null ? null : num(r.heading),
    accuracy_m: r.accuracy_m == null ? null : num(r.accuracy_m),
    recorded_at: String(r.recorded_at),
  }
}
function toEvent(r: Record<string, unknown>): EventRow {
  return { id: num(r.id), from_status: (r.from_status as string | null) ?? null, to_status: String(r.to_status), created_at: String(r.created_at) }
}

/**
 * Escuta um pedido pelo código: novos eventos da timeline e novas posições do motoboy.
 *
 * O canal é `order:<code>`. Quem decide o que cada assinante recebe é a RLS (o Realtime avalia a policy de
 * leitura para quem escuta): o cliente do pedido ativo recebe as posições; qualquer outra pessoa não recebe
 * nada, e depois da entrega a policy fecha e o fluxo seca. O código não é segredo nem credencial.
 *
 * Se o canal cair (rede que bloqueia websocket é comum), passa a consultar a cada `pollMs` e avisa com
 * `{ type: 'connection', state: 'polling' }`. Devolve a função que encerra tudo.
 */
export function subscribeToOrder(code: string, cb: (e: OrderUpdate) => void, options: SubscribeOptions = {}): () => void {
  let stopped = false
  let teardown: (() => void) | null = null

  void (async () => {
    try {
      const client = options.client ?? (await browserClient())
      if (stopped) return
      const { data: order } = await client.from('orders').select('id').eq('code', code).maybeSingle()
      if (!order || stopped) return // pedido que o usuário não pode ler (RLS) ou que não existe: nada a escutar
      const orderId = String(order.id)

      let lastEventId = 0
      let lastPositionAt = ''
      let timer: ReturnType<typeof setInterval> | null = null
      const emitEvent = (e: EventRow) => {
        if (e.id <= lastEventId) return
        lastEventId = e.id
        cb({ type: 'event', event: e })
      }
      const emitPosition = (p: PositionRow) => {
        if (p.recorded_at <= lastPositionAt) return
        lastPositionAt = p.recorded_at
        cb({ type: 'position', position: p })
      }

      const poll = async () => {
        const [ev, pos] = await Promise.all([
          client.from('order_events').select('id, from_status, to_status, created_at').eq('order_id', orderId).gt('id', lastEventId).order('id'),
          client
            .from('courier_positions')
            .select('lat, lng, heading, accuracy_m, recorded_at')
            .eq('order_id', orderId)
            .order('recorded_at', { ascending: false })
            .limit(1),
        ])
        for (const r of ev.data ?? []) emitEvent(toEvent(r))
        const latest = pos.data?.[0]
        if (latest) emitPosition(toPosition(latest))
      }
      const startPolling = () => {
        if (timer || stopped) return
        cb({ type: 'connection', state: 'polling' })
        void poll().catch(() => {})
        timer = setInterval(() => void poll().catch(() => {}), options.pollMs ?? 20_000)
      }
      const stopPolling = () => {
        if (timer) clearInterval(timer)
        timer = null
      }

      const channel = client
        .channel(`order:${code}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'order_events', filter: `order_id=eq.${orderId}` }, (p) =>
          emitEvent(toEvent(p.new)),
        )
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'courier_positions', filter: `order_id=eq.${orderId}` }, (p) =>
          emitPosition(toPosition(p.new)),
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            stopPolling()
            cb({ type: 'connection', state: 'live' })
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            startPolling()
          }
        })

      teardown = () => {
        stopPolling()
        void client.removeChannel(channel)
      }
      if (stopped) teardown()
    } catch {
      // Sem cliente, sem rede, sem sessão: a tela segue com o que o servidor entregou.
    }
  })()

  return () => {
    stopped = true
    teardown?.()
  }
}
