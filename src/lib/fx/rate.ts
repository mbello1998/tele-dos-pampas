import { connect } from '../../../scripts/db/client'

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

export interface EffectiveRate {
  rate: number
  spreadPct: number
  validForDate: string
  isStale: boolean
}

export const DEFAULT_FALLBACK_RATE = 7.8

// Um banco que não responde bloqueia o pedido tanto quanto um que falha: corta rápido e cai no fallback.
export const DB_TIMEOUT_MS = 3000

// As duas cidades ficam no mesmo fuso; "hoje" é a data local delas, não a do servidor (UTC).
const TIME_ZONE = 'America/Montevideo'

/** Data civil (YYYY-MM-DD) de um instante, no fuso de Quaraí/Artigas. */
export function toValidForDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

// Override manual vence a API na mesma data (is_manual_override desc vem primeiro, de propósito);
// entre linhas do mesmo tipo, a gravada por último.
const ORDER_WITHIN_DATE = 'is_manual_override desc, fetched_at desc, id'
const COLUMNS = 'rate::text as rate, spread_pct::text as spread_pct, valid_for_date::text as valid_for_date'

async function readFallbackRate(db: Queryable): Promise<number> {
  const { rows } = await db.query(`select value from public.settings where key = 'fx.fallback_rate'`)
  const raw = rows[0]?.value
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FALLBACK_RATE
}

async function lookup(db: Queryable, date: Date): Promise<EffectiveRate> {
  const day = toValidForDate(date)

  const exact = await db.query(
    `select ${COLUMNS} from public.fx_rates
     where pair = 'BRL/UYU' and valid_for_date = $1 order by ${ORDER_WITHIN_DATE} limit 1`,
    [day],
  )
  const latest = exact.rows[0]
    ? undefined
    : (
        await db.query(
          `select ${COLUMNS} from public.fx_rates
           where pair = 'BRL/UYU' order by valid_for_date desc, ${ORDER_WITHIN_DATE} limit 1`,
        )
      ).rows[0]

  const row = exact.rows[0] ?? latest
  if (!row) {
    return { rate: await readFallbackRate(db), spreadPct: 0, validForDate: day, isStale: true }
  }
  return {
    rate: Number(row.rate),
    spreadPct: Number(row.spread_pct),
    validForDate: String(row.valid_for_date),
    isStale: !exact.rows[0],
  }
}

/**
 * Taxa BRL->UYU vigente. Nunca lança: sem banco, devolve a taxa padrão marcada como defasada,
 * porque o app precisa continuar aceitando pedidos sem nenhuma dependência externa.
 * `db` é opcional (testes passam uma conexão dentro de transação); sem ele abre e fecha uma própria.
 */
export async function getEffectiveRate(date: Date = new Date(), db?: Queryable): Promise<EffectiveRate> {
  try {
    if (db) return await lookup(db, date)
    const client = await connect({ connectionTimeoutMillis: DB_TIMEOUT_MS, queryTimeoutMillis: DB_TIMEOUT_MS })
    try {
      return await lookup(client, date)
    } finally {
      await client.end().catch(() => undefined)
    }
  } catch (err) {
    console.error('[fx] leitura da taxa falhou, usando a padrão:', err instanceof Error ? err.message : 'erro desconhecido')
    return { rate: DEFAULT_FALLBACK_RATE, spreadPct: 0, validForDate: toValidForDate(date), isStale: true }
  }
}
