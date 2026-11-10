import type { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { connect } from '../../scripts/db/client'
import { DB_TIMEOUT_MS, getEffectiveRate } from '../../src/lib/fx/rate'
import handler, { updateFx } from '../../netlify/functions/update-fx'

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
    // A linha da API é MAIS NOVA em fetched_at e tem id maior: sem a preferência por is_manual_override,
    // ela venceria por qualquer critério de desempate. Só a flag faz o manual ganhar.
    await db.query(
      `insert into public.fx_rates (id, rate, source, spread_pct, is_manual_override, valid_for_date, fetched_at)
       values ('00000000-0000-0000-0000-000000000001', 8.1, 'manual', 3, true, '2026-11-09', '2026-11-09T08:00:00Z'),
              ('ffffffff-ffff-ffff-ffff-ffffffffffff', 7.9, 'fxfeed', 5, false, '2026-11-09', '2026-11-09T09:00:00Z')`,
    )
    const r = await getEffectiveRate(D, db)
    expect(r).toMatchObject({ rate: 8.1, spreadPct: 3, isStale: false })
  })

  test('banco que não responde (host inalcançável) cai no fallback dentro do timeout, sem pendurar', async () => {
    const saved = process.env.SUPABASE_DB_URL
    process.env.SUPABASE_DB_URL = 'postgresql://u:p@10.255.255.1:5432/postgres' // endereço sem rota
    const t0 = Date.now()
    try {
      const r = await getEffectiveRate(D)
      expect(r).toMatchObject({ rate: 7.8, isStale: true })
    } finally {
      process.env.SUPABASE_DB_URL = saved
    }
    expect(Date.now() - t0).toBeLessThan(DB_TIMEOUT_MS + 2000)
  }, 15000)

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

  test('mesma data duas vezes deixa exatamente uma linha da API (constraint + on conflict)', async () => {
    await insertRate('7.900000', '2026-11-09')
    await expect(
      db.query('savepoint s').then(() => insertRate('8.000000', '2026-11-09')),
    ).rejects.toThrow(/fx_rates_pair_date_kind_key/)
    await db.query('rollback to savepoint s')
    const res = await updateFx({ db, fetchFn: ok(9.99), apiKey: 'k', today: D, log })
    expect(res.status).toBe('skipped-existing')
    const { rows } = await db.query('select count(*)::int n from public.fx_rates')
    expect(rows[0].n).toBe(1)
  })

  test('execução duplicada do cron é no-op: segunda chamada não cria nem altera linha', async () => {
    await updateFx({ db, fetchFn: ok(7.83), apiKey: 'k', today: D, log })
    const first = await db.query('select * from public.fx_rates')
    const again = await updateFx({ db, fetchFn: ok(8.5), apiKey: 'k', today: D, log })
    expect(again.status).toBe('skipped-existing')
    expect((await db.query('select * from public.fx_rates')).rows).toEqual(first.rows)
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

  test('dia com linha manual e da API: o spread herdado é o do manual, como na leitura', async () => {
    await db.query(
      `insert into public.fx_rates (rate, source, spread_pct, is_manual_override, valid_for_date, fetched_at)
       values (8.1, 'manual', 3, true, '2026-11-08', '2026-11-08T08:00:00Z'),
              (7.9, 'fxfeed', 5, false, '2026-11-08', '2026-11-08T09:00:00Z')`,
    )
    expect(await getEffectiveRate(new Date('2026-11-08T12:00:00Z'), db)).toMatchObject({ spreadPct: 3 })
    await updateFx({ db, fetchFn: ok(7.8), apiKey: 'k', today: D, log })
    expect(await getEffectiveRate(D, db)).toMatchObject({ rate: 7.8, spreadPct: 3, isStale: false })
  })

  test('nova linha herda o spread da linha mais recente', async () => {
    await insertRate('7.700000', '2026-11-07', { spread: '6.50' })
    await updateFx({ db, fetchFn: ok(7.8), apiKey: 'k', today: D, log })
    const r = await getEffectiveRate(D, db)
    expect(r).toMatchObject({ rate: 7.8, spreadPct: 6.5, isStale: false })
  })
})

describe('handler (fiação de produção)', () => {
  test('o handler repassa o AbortSignal ao fetch real (global), não só ao fake dos testes', async () => {
    const seen: unknown[] = []
    const stub = vi.fn((_url: string, init?: RequestInit) => {
      seen.push(init?.signal)
      // HTTP 500: o handler termina em api-failed sem gravar nada no banco compartilhado.
      return Promise.resolve(new Response('boom', { status: 500 }))
    })
    vi.stubGlobal('fetch', stub)
    const savedKey = process.env.FXFEED_API_KEY
    process.env.FXFEED_API_KEY = 'chave-de-teste'
    try {
      const res = await handler()
      expect(res.status).toBe(200)
    } finally {
      vi.unstubAllGlobals()
      if (savedKey === undefined) delete process.env.FXFEED_API_KEY
      else process.env.FXFEED_API_KEY = savedKey
    }
    expect(stub).toHaveBeenCalledTimes(1)
    expect(seen[0]).toBeInstanceOf(AbortSignal)
  })
})
