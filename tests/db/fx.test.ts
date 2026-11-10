import type { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { connect } from '../../scripts/db/client'
import { getEffectiveRate } from '../../src/lib/fx/rate'
import { updateFx } from '../../netlify/functions/update-fx'

let db: Client

beforeAll(async () => {
  db = await connect()
})
afterAll(async () => {
  await db.end()
})
// Isolation: every test runs inside a transaction that is always rolled back.
beforeEach(async () => {
  await db.query('begin')
  // Só dentro da transação (sempre revertida): ponto de partida determinístico.
  await db.query('delete from public.fx_rates')
  await db.query(`delete from public.settings where key = 'fx.fallback_rate'`)
})
afterEach(async () => {
  await db.query('rollback')
})

const insertRate = (rate: string, date: string, opts: { source?: string; manual?: boolean; spread?: string } = {}) =>
  db.query(
    `insert into public.fx_rates (rate, source, spread_pct, is_manual_override, valid_for_date)
     values ($1, $2, $3, $4, $5)`,
    [rate, opts.source ?? 'fxfeed', opts.spread ?? '5', opts.manual ?? false, date],
  )

const D = new Date('2026-11-09T12:00:00Z')

describe('getEffectiveRate', () => {
  test('tabela fx_rates vazia usa a taxa padrão de settings e marca isStale', async () => {
    await db.query(`insert into public.settings (key, value) values ('fx.fallback_rate', '8.25'::jsonb)`)
    const r = await getEffectiveRate(D, db)
    expect(r).toMatchObject({ rate: 8.25, isStale: true, spreadPct: 0 })
  })

  test('tabela vazia e sem setting: usa 7.80 e marca isStale', async () => {
    const r = await getEffectiveRate(D, db)
    expect(r).toMatchObject({ rate: 7.8, isStale: true })
  })

  test('linha da data pedida: usa e não é stale', async () => {
    await insertRate('7.900000', '2026-11-09', { spread: '5' })
    const r = await getEffectiveRate(D, db)
    expect(r).toEqual({ rate: 7.9, spreadPct: 5, validForDate: '2026-11-09', isStale: false })
  })

  test('data sem linha cai na mais recente e marca isStale', async () => {
    await insertRate('7.700000', '2026-11-05')
    await insertRate('7.750000', '2026-11-07')
    const r = await getEffectiveRate(D, db)
    expect(r).toMatchObject({ rate: 7.75, validForDate: '2026-11-07', isStale: true })
  })

  test('data pedida mais antiga que todas as linhas ainda devolve a mais recente, stale', async () => {
    await insertRate('7.700000', '2026-11-05')
    const r = await getEffectiveRate(new Date('2026-10-01T12:00:00Z'), db)
    expect(r).toMatchObject({ rate: 7.7, isStale: true })
  })

  test('override manual tem precedência sobre a taxa da API na mesma data', async () => {
    await insertRate('7.900000', '2026-11-09', { source: 'fxfeed' })
    await insertRate('8.100000', '2026-11-09', { source: 'manual', manual: true, spread: '3' })
    // inserida depois, para provar que a precedência não é "a última vence"
    await insertRate('7.950000', '2026-11-09', { source: 'fxfeed' })
    const r = await getEffectiveRate(D, db)
    expect(r).toMatchObject({ rate: 8.1, spreadPct: 3, isStale: false })
  })

  test('banco inacessível: não lança, devolve 7.80 stale', async () => {
    const broken = { query: () => Promise.reject(new Error('db down')) }
    const r = await getEffectiveRate(D, broken as never)
    expect(r).toMatchObject({ rate: 7.8, isStale: true })
  })
})

describe('updateFx', () => {
  const ok = (uyu: number) =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ rates: { UYU: uyu } }), { status: 200 }))
  const log = vi.fn()

  test('insere uma nova linha para hoje, fonte fxfeed', async () => {
    const res = await updateFx({ db, fetchFn: ok(7.83), apiKey: 'k', today: D, log })
    expect(res.status).toBe('inserted')
    const { rows } = await db.query(
      `select rate::text, source, is_manual_override, valid_for_date::text d from public.fx_rates`,
    )
    expect(rows).toEqual([{ rate: '7.830000', source: 'fxfeed', is_manual_override: false, d: '2026-11-09' }])
  })

  test('não sobrescreve linha existente da mesma data', async () => {
    await insertRate('7.900000', '2026-11-09')
    const before = await db.query('select * from public.fx_rates')
    const res = await updateFx({ db, fetchFn: ok(9.99), apiKey: 'k', today: D, log })
    expect(res.status).toBe('skipped-existing')
    const after = await db.query('select * from public.fx_rates')
    expect(after.rows).toEqual(before.rows)
  })

  test('API fora do ar mantém a última taxa gravada e marca isStale', async () => {
    await insertRate('7.700000', '2026-11-07')
    const dead = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'))
    const res = await updateFx({ db, fetchFn: dead, apiKey: 'k', today: D, log })
    expect(res.status).toBe('api-failed')
    const { rows } = await db.query('select count(*)::int n from public.fx_rates')
    expect(rows[0].n).toBe(1)
    expect(await getEffectiveRate(D, db)).toMatchObject({ rate: 7.7, validForDate: '2026-11-07', isStale: true })
  })

  test('nova linha herda o spread da linha mais recente', async () => {
    await insertRate('7.700000', '2026-11-07', { spread: '6.50' })
    await updateFx({ db, fetchFn: ok(7.8), apiKey: 'k', today: D, log })
    const r = await getEffectiveRate(D, db)
    expect(r).toMatchObject({ rate: 7.8, spreadPct: 6.5, isStale: false })
  })
})
