import { describe, expect, test, vi } from 'vitest'
import { updateFx, type Queryable } from '../../netlify/functions/update-fx'

// Banco falso: toda consulta é registrada. Os testes de "sem escrita" exigem lista vazia.
function fakeDb(): Queryable & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    query: (async (sql: string) => {
      calls.push(sql)
      return { rows: [], rowCount: 0 }
    }) as Queryable['query'],
  }
}

const TODAY = new Date('2026-11-09T12:00:00Z')

describe('update-fx sem chave de API', () => {
  test('chave ausente: loga, termina com sucesso e não toca no banco nem na rede', async () => {
    const db = fakeDb()
    const fetchFn = vi.fn()
    const log = vi.fn()
    const result = await updateFx({ db, fetchFn, apiKey: undefined, today: TODAY, log })
    expect(result.status).toBe('no-key')
    expect(db.calls).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('FXFEED_API_KEY'))
  })

  test('chave em branco conta como ausente', async () => {
    const db = fakeDb()
    const result = await updateFx({ db, fetchFn: vi.fn(), apiKey: '   ', today: TODAY, log: vi.fn() })
    expect(result.status).toBe('no-key')
    expect(db.calls).toEqual([])
  })
})

describe('update-fx com API fora do ar', () => {
  test('rede falha: não lança e não escreve', async () => {
    const db = fakeDb()
    const fetchFn = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const result = await updateFx({ db, fetchFn, apiKey: 'k', today: TODAY, log: vi.fn() })
    expect(result.status).toBe('api-failed')
    expect(db.calls).toEqual([])
  })

  test('HTTP 500 e corpo inválido também terminam sem escrever', async () => {
    for (const res of [
      new Response('boom', { status: 500 }),
      new Response(JSON.stringify({ rates: {} }), { status: 200 }),
      new Response(JSON.stringify({ rates: { UYU: -3 } }), { status: 200 }),
    ]) {
      const db = fakeDb()
      const result = await updateFx({ db, fetchFn: vi.fn().mockResolvedValue(res), apiKey: 'k', today: TODAY, log: vi.fn() })
      expect(result.status).toBe('api-failed')
      expect(db.calls).toEqual([])
    }
  })

  test('a chave nunca aparece nos logs', async () => {
    const log = vi.fn()
    const fetchFn = vi.fn().mockRejectedValue(new Error('falhou https://x?api_key=SEGREDO123'))
    await updateFx({ db: fakeDb(), fetchFn, apiKey: 'SEGREDO123', today: TODAY, log })
    expect(JSON.stringify(log.mock.calls)).not.toContain('SEGREDO123')
  })
})
