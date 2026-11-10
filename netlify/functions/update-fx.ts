import { connect } from '../../scripts/db/client'
import { toValidForDate, type Queryable } from '../../src/lib/fx/rate'

export type { Queryable }

export type UpdateFxStatus = 'inserted' | 'skipped-existing' | 'no-key' | 'api-failed'

export interface UpdateFxOptions {
  db: Queryable
  fetchFn: (url: string, init?: { signal: AbortSignal }) => Promise<Response>
  apiKey: string | undefined
  today: Date
  log: (message: string) => void
}

const FXFEED_URL = 'https://api.fxfeed.io/v2/latest?base=BRL&currencies=UYU'

class FxFeedError extends Error {}

const RAW_LOG_LIMIT = 300
export const FETCH_TIMEOUT_MS = 5000

/**
 * FXFeed, confirmado em https://fxfeed.io/docs: GET /v2/latest com `base`, `currencies` (lista
 * separada por vírgula) e `api_key` na QUERY STRING (não é header). Resposta de sucesso:
 * { success: true, base, date, rates: { UYU: number } }; erros não trazem success: true.
 * Plano grátis: 5.000 requisições/mês.
 * Não confiamos nem no HTTP 200: o corpo é validado e, se estiver fora do formato, nada é gravado.
 */
async function fetchRate(fetchFn: UpdateFxOptions['fetchFn'], apiKey: string, log: UpdateFxOptions['log']): Promise<number> {
  // Mesmo padrão de src/lib/geo/osrm.ts: AbortController com teto; cobre também a leitura do corpo.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let raw: string
  try {
    const res = await fetchFn(`${FXFEED_URL}&api_key=${encodeURIComponent(apiKey)}`, { signal: controller.signal })
    if (!res.ok) throw new FxFeedError(`FXFeed respondeu HTTP ${res.status}`)
    raw = await res.text()
  } finally {
    clearTimeout(timer)
  }
  const logRaw = (why: string): FxFeedError => {
    // Corpo bruto truncado ajuda a diagnosticar; a chave é removida caso o provedor a ecoe.
    const shown = raw.split(apiKey).join('***').split(encodeURIComponent(apiKey)).join('***').slice(0, RAW_LOG_LIMIT)
    log(`[update-fx] ${why}. Corpo recebido (truncado): ${shown}`)
    return new FxFeedError(`FXFeed: ${why}`)
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw logRaw('corpo não é JSON')
  }
  const obj = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const rates = typeof obj.rates === 'object' && obj.rates !== null ? (obj.rates as Record<string, unknown>) : {}
  const rate = rates.UYU
  if (obj.success === false || typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw logRaw('corpo sem rates.UYU válido')
  }
  return rate
}

/**
 * Grava a taxa do dia. Só insere: fx_rates é versionada por data e os pedidos apontam para a linha
 * exata que usaram, então nenhuma linha existente é alterada. Falha da API não é erro: registra e sai.
 */
export async function updateFx({ db, fetchFn, apiKey, today, log }: UpdateFxOptions): Promise<{ status: UpdateFxStatus }> {
  if (!apiKey || apiKey.trim() === '') {
    log('[update-fx] FXFEED_API_KEY ausente: nada a fazer, nenhuma linha gravada.')
    return { status: 'no-key' }
  }

  let rate: number
  try {
    rate = await fetchRate(fetchFn, apiKey.trim(), log)
  } catch (err) {
    // A mensagem pode carregar a URL com a chave; nunca a repassamos ao log.
    const reason = err instanceof FxFeedError ? err.message : 'falha de rede ou resposta ilegível'
    log(`[update-fx] API indisponível (${reason}): taxa mantida, nenhuma linha gravada.`)
    return { status: 'api-failed' }
  }

  const day = toValidForDate(today)
  // Spread é decisão de negócio, não da API: herda o da linha mais recente (0 se não houver).
  // Essa linha pode ser um override manual: o spread dele passa adiante para as linhas seguintes da
  // API até alguém alterá-lo. A ordem (manual primeiro) é a mesma de getEffectiveRate.
  // `on conflict do nothing` (constraint da migração 0015) torna a repetição um no-op, mesmo concorrente.
  const { rows } = await db.query(
    `insert into public.fx_rates (rate, source, spread_pct, is_manual_override, valid_for_date)
     select $1::numeric, 'fxfeed', coalesce(
              (select spread_pct from public.fx_rates where pair = 'BRL/UYU'
               order by valid_for_date desc, is_manual_override desc, fetched_at desc limit 1), 0),
            false, $2::date
     on conflict (pair, valid_for_date, is_manual_override) do nothing
     returning id`,
    [rate.toFixed(6), day],
  )
  if (rows.length === 0) {
    log(`[update-fx] já existe taxa da API para ${day}: mantida, nada sobrescrito.`)
    return { status: 'skipped-existing' }
  }
  log(`[update-fx] taxa de ${day} gravada.`)
  return { status: 'inserted' }
}

// Função agendada da Netlify (ver netlify.toml). Sempre termina com sucesso.
export default async function handler(): Promise<Response> {
  try {
    const db = await connect()
    try {
      await updateFx({
        db,
        fetchFn: (url, init) => fetch(url, init),
        apiKey: process.env.FXFEED_API_KEY,
        today: new Date(),
        log: (m) => console.log(m),
      })
    } finally {
      await db.end().catch(() => undefined)
    }
  } catch (err) {
    console.error('[update-fx] erro inesperado, nada alterado:', err instanceof Error ? err.message : 'erro desconhecido')
  }
  return new Response(null, { status: 200 })
}
