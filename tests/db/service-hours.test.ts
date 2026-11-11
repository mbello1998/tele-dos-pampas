import { readFileSync } from 'node:fs'
import type { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { connect } from '../../scripts/db/client'
import { ID, FIXTURE_SQL, actAs, asOwner, attempt } from './rls-helpers'

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 })

let db: Client

beforeAll(async () => {
  db = await connect()
})
afterAll(async () => {
  await db.end()
})
// Isolation: every test runs in a transaction that is always rolled back (the database is shared).
beforeEach(async () => {
  await db.query('begin')
})
afterEach(async () => {
  await db.query('rollback')
})

/** Instants are written with an explicit -03 offset: both cities are UTC-3 all year round. */
const within = async (city: string, kind: string, at: string) => {
  const r = await db.query<{ ok: boolean }>(`select public.is_within_service_hours($1, $2, $3::timestamptz) as ok`, [
    city,
    kind,
    at,
  ])
  return r.rows[0].ok
}

describe('horário de serviço', () => {
  test('remove a chave bridge_hours de settings: travessia nunca bloqueia por horário', async () => {
    const r = await db.query(`select key from public.settings where key = 'bridge_hours'`)
    expect(r.rows).toEqual([])
    // o seed roda a cada db:migrate: se ele a inserisse, a chave voltaria
    expect(readFileSync('supabase/seed.sql', 'utf8')).not.toMatch(/'bridge_hours'/)
  })

  test('o teto global service_radius_km é 5', async () => {
    const r = await db.query(`select value from public.settings where key = 'service_radius_km'`)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].value).toBe(5)
  })

  test('service_hours tem entrada para quarai e artigas, cada uma com delivery, courier e ride', async () => {
    const r = await db.query<{ value: Record<string, Record<string, unknown>>; is_public: boolean }>(
      `select value, is_public from public.settings where key = 'service_hours'`,
    )
    expect(r.rows).toHaveLength(1)
    const v = r.rows[0].value
    expect(Object.keys(v).sort()).toEqual(['artigas', 'quarai'])
    for (const city of ['quarai', 'artigas']) {
      for (const kind of ['delivery', 'courier', 'ride']) {
        expect(v[city][kind], `${city}.${kind}`).toEqual({ opens: '06:00', closes: '00:00' })
      }
      expect(typeof v[city].timezone).toBe('string')
    }
    expect(r.rows[0].is_public).toBe(true)
  })

  test('is_within_service_hours em 23:30 retorna true', async () => {
    for (const kind of ['delivery', 'courier', 'ride']) {
      expect(await within('quarai', kind, '2026-11-10 23:30:00-03')).toBe(true)
      expect(await within('artigas', kind, '2026-11-10 23:30:00-03')).toBe(true)
    }
  })

  test('is_within_service_hours em 00:30 retorna false', async () => {
    for (const kind of ['delivery', 'courier', 'ride']) {
      expect(await within('quarai', kind, '2026-11-11 00:30:00-03')).toBe(false)
      expect(await within('artigas', kind, '2026-11-11 00:30:00-03')).toBe(false)
    }
  })

  test('janela que cruza a meia-noite é avaliada corretamente (fronteiras 23:30, 00:00, 00:30, 05:30, 06:00)', async () => {
    const at = (t: string) => within('quarai', 'delivery', `2026-11-10 ${t}-03`)
    expect(await at('23:30:00')).toBe(true) // dentro
    expect(await at('23:59:59')).toBe(true) // último segundo aberto
    expect(await at('00:00:00')).toBe(false) // o fim é exclusivo: 00:00 já está fechado
    expect(await at('00:30:00')).toBe(false)
    expect(await at('05:30:00')).toBe(false)
    expect(await at('05:59:59')).toBe(false)
    expect(await at('06:00:00')).toBe(true) // o início é inclusivo
    expect(await at('12:00:00')).toBe(true)
  })

  test('o horário vale no relógio da cidade, não no do servidor (UTC)', async () => {
    // 02:30Z é 23:30 em Quaraí (aberto); 06:30Z é 03:30 (fechado). Em UTC puro seria o contrário.
    expect(await within('quarai', 'delivery', '2026-11-11 02:30:00+00')).toBe(true)
    expect(await within('quarai', 'delivery', '2026-11-11 06:30:00+00')).toBe(false)
    expect(await within('artigas', 'ride', '2026-11-11 02:30:00+00')).toBe(true)
    expect(await within('artigas', 'ride', '2026-11-11 06:30:00+00')).toBe(false)
  })

  test('is_within_service_hours respeita cidade: uma pode fechar antes da outra', async () => {
    await db.query(
      `update public.settings
          set value = jsonb_set(value, '{artigas,delivery}', '{"opens":"06:00","closes":"22:00"}')
        where key = 'service_hours'`,
    )
    expect(await within('artigas', 'delivery', '2026-11-10 23:30:00-03')).toBe(false)
    expect(await within('quarai', 'delivery', '2026-11-10 23:30:00-03')).toBe(true)
    // e por kind: só o delivery de Artigas mudou
    expect(await within('artigas', 'ride', '2026-11-10 23:30:00-03')).toBe(true)
    expect(await within('artigas', 'delivery', '2026-11-10 21:59:00-03')).toBe(true)
  })

  test('janela comum (sem cruzar a meia-noite) também funciona, e opens = closes significa 24 horas', async () => {
    await db.query(
      `update public.settings
          set value = jsonb_set(jsonb_set(value, '{quarai,courier}', '{"opens":"08:00","closes":"18:00"}'),
                                '{quarai,ride}', '{"opens":"00:00","closes":"00:00"}')
        where key = 'service_hours'`,
    )
    expect(await within('quarai', 'courier', '2026-11-10 07:59:00-03')).toBe(false)
    expect(await within('quarai', 'courier', '2026-11-10 08:00:00-03')).toBe(true)
    expect(await within('quarai', 'courier', '2026-11-10 17:59:00-03')).toBe(true)
    expect(await within('quarai', 'courier', '2026-11-10 18:00:00-03')).toBe(false)
    expect(await within('quarai', 'ride', '2026-11-10 03:00:00-03')).toBe(true)
  })

  test('cidade ou kind sem configuração é erro explícito, nunca um "fechado" silencioso', async () => {
    const a = await attempt(db, `select public.is_within_service_hours('rivera', 'delivery', now())`)
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.message).toMatch(/service_hours[\s\S]*rivera/) // a mensagem nomeia a configuração e a cidade
    await db.query(`update public.settings set value = value #- '{quarai,ride}' where key = 'service_hours'`)
    const b = await attempt(db, `select public.is_within_service_hours('quarai', 'ride', now())`)
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.message).toMatch(/service_hours[\s\S]*quarai[\s\S]*ride/)
  })

  test('janela malformada falha FECHADO: erro explícito, nunca NULL (que `if not f()` trataria como aberto)', async () => {
    const bad = async (patch: string, label: string) => {
      await db.query(`update public.settings set value = jsonb_set(value, '{quarai,delivery}', '${patch}') where key = 'service_hours'`)
      const r = await attempt(db, `select public.is_within_service_hours('quarai', 'delivery', '2026-11-10 03:00:00-03') as ok`)
      expect(r.ok, `${label}: must raise, not return ${r.ok ? JSON.stringify(r.rows[0].ok) : ''}`).toBe(false)
      if (!r.ok) expect(r.message, label).toMatch(/service_hours[\s\S]*quarai[\s\S]*delivery/)
    }
    await bad('{}', 'empty window')
    await bad('{"opens":"06:00"}', 'missing closes')
    await bad('{"closes":"00:00"}', 'missing opens')
    await bad('{"opens":"06:00","closes":null}', 'null closes')
    await bad('{"opens":"six","closes":"00:00"}', 'unreadable time')
    await bad('{"opens":"25:99","closes":"00:00"}', 'out-of-range time')
    // a non-object window was already refused: keep it pinned
    await db.query(`update public.settings set value = jsonb_set(value, '{quarai,delivery}', '"06:00-00:00"') where key = 'service_hours'`)
    const str = await attempt(db, `select public.is_within_service_hours('quarai', 'delivery', now())`)
    expect(str.ok).toBe(false)
  })

  test('instante nulo é erro, não NULL; kind desconhecido também falha (fechado)', async () => {
    const a = await attempt(db, `select public.is_within_service_hours('quarai', 'delivery', null)`)
    expect(a.ok).toBe(false)
    if (!a.ok) expect(a.message).toMatch(/must not be null/)
    const b = await attempt(db, `select public.is_within_service_hours('quarai', 'teleport', now())`)
    expect(b.ok).toBe(false) // 22P02 from the enum cast
    if (!b.ok) expect(b.code).toBe('22P02')
  })

  test('quem chama a função: logado sim, anônimo não (a chave em settings é pública)', async () => {
    await db.query(FIXTURE_SQL)
    await actAs(db, { uid: ID.clientA })
    const ok = await attempt(db, `select public.is_within_service_hours('quarai', 'delivery', '2026-11-10 12:00-03') as ok`)
    expect(ok.ok && ok.rows[0].ok).toBe(true)
    await actAs(db, 'anon')
    const denied = await attempt(db, `select public.is_within_service_hours('quarai', 'delivery', now())`)
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.code).toBe('42501')
    const pub = await attempt(db, `select key from public.settings where key = 'service_hours'`)
    expect(pub.ok && pub.rows).toHaveLength(1)
    await asOwner(db, 'select 1')
  })
})
