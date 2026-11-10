import { connect } from '../../scripts/db/client'
import { toValidForDate, type Queryable } from '../../src/lib/fx/rate'

export type { Queryable }

export type UpdateFxStatus = 'inserted' | 'skipped-existing' | 'no-key' | 'api-failed'

export interface UpdateFxOptions {
  db: Queryable
  fetchFn: (url: string) => Promise<Response>
  apiKey: string | undefined
  today: Date
  log: (message: string) => void
}

const FXFEED_URL = 'https://api.fxfeed.io/v2/latest?base=BRL&currencies=UYU'

async function fetchRate(fetchFn: UpdateFxOptions['fetchFn'], apiKey: string): Promise<number> {
  const res = await fetchFn(`${FXFEED_URL}&api_key=${encodeURIComponent(apiKey)}`)
  if (!res.ok) throw new Error(`FXFeed respondeu HTTP ${res.status}`)
  const body = (await res.json()) as { rates?: { UYU?: unknown } }
  const rate = body.rates?.UYU
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new Error('FXFeed devolveu corpo sem taxa UYU válida')
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
    rate = await fetchRate(fetchFn, apiKey.trim())
  } catch (err) {
    // A mensagem pode carregar a URL com a chave; nunca a repassamos ao log.
    const reason = err instanceof Error && err.message.startsWith('FXFeed') ? err.message : 'falha de rede ou resposta ilegível'
    log(`[update-fx] API indisponível (${reason}): taxa mantida, nenhuma linha gravada.`)
    return { status: 'api-failed' }
  }

  const day = toValidForDate(today)
  // Spread é decisão de negócio, não da API: herda o da linha mais recente (0 se não houver).
  // `where not exists` torna a checagem e o insert um único comando: sem corrida, sem update.
  const { rows } = await db.query(
    `insert into public.fx_rates (rate, source, spread_pct, is_manual_override, valid_for_date)
     select $1::numeric, 'fxfeed', coalesce(
              (select spread_pct from public.fx_rates where pair = 'BRL/UYU'
               order by valid_for_date desc, fetched_at desc limit 1), 0),
            false, $2::date
     where not exists (select 1 from public.fx_rates where pair = 'BRL/UYU' and valid_for_date = $2::date)
     returning id`,
    [rate.toFixed(6), day],
  )
  if (rows.length === 0) {
    log(`[update-fx] já existe taxa para ${day}: mantida, nada sobrescrito.`)
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
        fetchFn: (url) => fetch(url),
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
