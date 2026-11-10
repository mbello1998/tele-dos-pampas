import type { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { connect } from '../../scripts/db/client'
import { DB_TIMEOUT_MS, getEffectiveRate, type Queryable } from '../../src/lib/fx/rate'
import handler, { updateFx } from '../../netlify/functions/update-fx'

let db: Client

beforeAll(async () => {
  db = await connect()
})
afterAll(async () => {
  await db.end()
})
// Isolation: every test runs inside a transaction that is always rolled back.
// fx_rates é histórico protegido por trigger (nenhum update/delete, para ninguém): os testes nunca
// limpam a tabela. Em vez disso gravam em datas de 2099, que não colidem com dado real e são sempre
// as "mais recentes", e afirmam só sobre essas datas. Passam com a tabela vazia ou com linhas reais.
beforeEach(async () => {
  await db.query('begin')
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

const D = new Date('2099-06-10T12:00:00Z')
const DAY = '2099-06-10'
const ok = (uyu: number) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify({ rates: { UYU: uyu } }), { status: 200 }))
const log = vi.fn()

// Banco sem nenhuma linha em fx_rates, com `fallback` opcional em settings: o caminho "tabela vazia"
// não pode ser exercitado no banco compartilhado sem apagar histórico, o que o trigger proíbe.
const emptyDb = (fallback?: unknown): Queryable => ({
  query: async (sql: string) => ({
    rows: sql.includes('from public.settings') && fallback !== undefined ? [{ value: fallback }] : [],
  }),
})

describe('getEffectiveRate', () => {
  test('tabela fx_rates vazia usa a taxa padrão de settings e marca isStale', async () => {
    const r = await getEffectiveRate(D, emptyDb(8.25))
    expect(r).toMatchObject({ rate: 8.25, isStale: true, spreadPct: 0 })
  })

  test('tabela vazia e sem setting (ou setting inválida): usa 7.80 e marca isStale', async () => {
    expect(await getEffectiveRate(D, emptyDb())).toMatchObject({ rate: 7.8, isStale: true })
    expect(await getEffectiveRate(D, emptyDb('lixo'))).toMatchObject({ rate: 7.8, isStale: true })
  })

  test('linha da data pedida: usa e não é stale', async () => {
    await insertRate('7.900000', DAY, { spread: '5' })
    const r = await getEffectiveRate(D, db)
    expect(r).toEqual({ rate: 7.9, spreadPct: 5, validForDate: DAY, isStale: false })
  })

  test('data sem linha cai na mais recente e marca isStale', async () => {
    await insertRate('7.700000', '2099-06-05')
    await insertRate('7.750000', '2099-06-07')
    const r = await getEffectiveRate(D, db)
    expect(r).toMatchObject({ rate: 7.75, validForDate: '2099-06-07', isStale: true })
  })

  test('com linhas reais no banco e nenhuma para a data pedida, devolve a mais recente como stale (não o 7.80)', async () => {
    // Linha realista, dentro da transação revertida; sem ela o resultado dependeria do banco.
    await insertRate('7.810000', '2099-06-01', { spread: '4.50' })
    const r = await getEffectiveRate(D, db)
    expect(r).toEqual({ rate: 7.81, spreadPct: 4.5, validForDate: '2099-06-01', isStale: true })
  })

  test('linha real de hoje presente no banco não interfere nas asserções sobre as datas de 2099', async () => {
    await insertRate('9.990000', '2026-11-10', { spread: '1' }) // linha realista, só dentro da transação
    await insertRate('7.750000', '2099-06-07')
    expect(await getEffectiveRate(D, db)).toMatchObject({ rate: 7.75, validForDate: '2099-06-07', isStale: true })
    const res = await updateFx({ db, fetchFn: ok(7.83), apiKey: 'k', today: D, log })
    expect(res.status).toBe('inserted')
    expect(await getEffectiveRate(D, db)).toMatchObject({ rate: 7.83, spreadPct: 5, isStale: false })
  })

  test('data pedida mais antiga que todas as linhas ainda devolve a mais recente, stale', async () => {
    await insertRate('7.700000', '2099-06-05')
    const r = await getEffectiveRate(new Date('2098-01-01T12:00:00Z'), db)
    expect(r).toMatchObject({ rate: 7.7, validForDate: '2099-06-05', isStale: true })
  })

  test('override manual tem precedência sobre a taxa da API na mesma data', async () => {
    // A linha da API é MAIS NOVA em fetched_at e tem id maior: sem a preferência por is_manual_override,
    // ela venceria por qualquer critério de desempate. Só a flag faz o manual ganhar.
    await db.query(
      `insert into public.fx_rates (id, rate, source, spread_pct, is_manual_override, valid_for_date, fetched_at)
       values ('00000000-0000-0000-0000-000000000001', 8.1, 'manual', 3, true, '${DAY}', '2099-06-10T08:00:00Z'),
              ('ffffffff-ffff-ffff-ffff-ffffffffffff', 7.9, 'fxfeed', 5, false, '${DAY}', '2099-06-10T09:00:00Z')`,
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
      if (saved === undefined) delete process.env.SUPABASE_DB_URL
      else process.env.SUPABASE_DB_URL = saved
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
  const rowsFor = (day: string) =>
    db.query(
      `select rate::text, source, is_manual_override, valid_for_date::text d from public.fx_rates where valid_for_date = $1 order by is_manual_override`,
      [day],
    )

  test('insere uma nova linha para hoje, fonte fxfeed', async () => {
    const res = await updateFx({ db, fetchFn: ok(7.83), apiKey: 'k', today: D, log })
    expect(res.status).toBe('inserted')
    expect((await rowsFor(DAY)).rows).toEqual([{ rate: '7.830000', source: 'fxfeed', is_manual_override: false, d: DAY }])
  })

  test('não sobrescreve linha existente da mesma data', async () => {
    await insertRate('7.900000', DAY)
    const before = await db.query('select * from public.fx_rates where valid_for_date = $1', [DAY])
    const res = await updateFx({ db, fetchFn: ok(9.99), apiKey: 'k', today: D, log })
    expect(res.status).toBe('skipped-existing')
    const after = await db.query('select * from public.fx_rates where valid_for_date = $1', [DAY])
    expect(after.rows).toEqual(before.rows)
  })

  test('mesma data duas vezes deixa exatamente uma linha da API (constraint + on conflict)', async () => {
    await insertRate('7.900000', DAY)
    await db.query('savepoint s')
    await expect(insertRate('8.000000', DAY)).rejects.toThrow(/fx_rates_pair_date_kind_key/)
    await db.query('rollback to savepoint s')
    const res = await updateFx({ db, fetchFn: ok(9.99), apiKey: 'k', today: D, log })
    expect(res.status).toBe('skipped-existing')
    expect((await rowsFor(DAY)).rows).toHaveLength(1)
  })

  test('execução duplicada do cron é no-op: segunda chamada não cria nem altera linha', async () => {
    await updateFx({ db, fetchFn: ok(7.83), apiKey: 'k', today: D, log })
    const first = await db.query('select * from public.fx_rates where valid_for_date = $1', [DAY])
    const again = await updateFx({ db, fetchFn: ok(8.5), apiKey: 'k', today: D, log })
    expect(again.status).toBe('skipped-existing')
    expect((await db.query('select * from public.fx_rates where valid_for_date = $1', [DAY])).rows).toEqual(first.rows)
  })

  test('API fora do ar mantém a última taxa gravada e marca isStale', async () => {
    await insertRate('7.700000', '2099-06-07')
    const dead = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'))
    const res = await updateFx({ db, fetchFn: dead, apiKey: 'k', today: D, log })
    expect(res.status).toBe('api-failed')
    expect((await rowsFor(DAY)).rows).toHaveLength(0)
    expect(await getEffectiveRate(D, db)).toMatchObject({ rate: 7.7, validForDate: '2099-06-07', isStale: true })
  })

  test('dia com linha manual e da API: o spread herdado é o do manual, como na leitura', async () => {
    await db.query(
      `insert into public.fx_rates (rate, source, spread_pct, is_manual_override, valid_for_date, fetched_at)
       values (8.1, 'manual', 3, true, '2099-06-08', '2099-06-08T08:00:00Z'),
              (7.9, 'fxfeed', 5, false, '2099-06-08', '2099-06-08T09:00:00Z')`,
    )
    expect(await getEffectiveRate(new Date('2099-06-08T12:00:00Z'), db)).toMatchObject({ spreadPct: 3 })
    await updateFx({ db, fetchFn: ok(7.8), apiKey: 'k', today: D, log })
    expect(await getEffectiveRate(D, db)).toMatchObject({ rate: 7.8, spreadPct: 3, isStale: false })
  })

  test('nova linha herda o spread da linha mais recente', async () => {
    await insertRate('7.700000', '2099-06-07', { spread: '6.50' })
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
