import { overpassQueryWithMeta } from '../../scripts/osm/overpass'

const json = (body: object) => new Response(JSON.stringify(body), { status: 200 })
const quiet = { log: () => {}, backoffMs: [1, 1] }
const asFetch = (fn: (url: string) => Promise<Response>) => fn as unknown as typeof fetch

test('um timeout passa direto para o próximo mirror, sem repetir no mesmo host', async () => {
  const calls: string[] = []
  const fetchImpl = asFetch(async (url) => {
    calls.push(url.split('?')[0])
    if (url.startsWith('https://a.test')) throw new DOMException('timed out', 'TimeoutError')
    return json({ elements: [{ id: 1 }], osm3s: { timestamp_osm_base: '2026-11-09T00:00:00Z' } })
  })

  const r = await overpassQueryWithMeta<{ id: number }>('q', {
    ...quiet,
    endpoints: ['https://a.test/x', 'https://b.test/x'],
    fetchImpl,
  })
  expect(calls).toEqual(['https://a.test/x', 'https://b.test/x'])
  expect(r.meta).toEqual({ mirror: 'https://b.test/x', osmBaseTimestamp: '2026-11-09T00:00:00Z' })
  expect(r.elements).toEqual([{ id: 1 }])
})

test('502 faz recuo e repete no mesmo host; erro não retentável muda de mirror', async () => {
  const calls: string[] = []
  let a = 0
  const fetchImpl = asFetch(async (url) => {
    calls.push(url.split('?')[0])
    if (url.startsWith('https://a.test')) {
      return ++a < 3 ? new Response('', { status: 502 }) : json({ elements: [{ id: 7 }] })
    }
    return new Response('', { status: 406 })
  })
  const r = await overpassQueryWithMeta<{ id: number }>('q', {
    ...quiet,
    endpoints: ['https://a.test/x', 'https://b.test/x'],
    fetchImpl,
  })
  expect(calls).toEqual(['https://a.test/x', 'https://a.test/x', 'https://a.test/x'])
  expect(r.elements).toEqual([{ id: 7 }])

  calls.length = 0
  const r2 = await overpassQueryWithMeta<{ id: number }>('q', {
    ...quiet,
    endpoints: ['https://b.test/x', 'https://c.test/x'],
    fetchImpl: asFetch(async (url) => {
      calls.push(url.split('?')[0])
      return url.startsWith('https://b.test') ? new Response('', { status: 406 }) : json({ elements: [] })
    }),
  })
  expect(calls).toEqual(['https://b.test/x', 'https://c.test/x'])
  expect(r2.meta.mirror).toBe('https://c.test/x')
})

test('resposta 200 com remark (truncada) falha alto em vez de devolver elementos parciais', async () => {
  const fetchImpl = asFetch(async () =>
    json({ elements: [{ id: 1 }], remark: 'runtime error: Query timed out' }),
  )
  await expect(
    overpassQueryWithMeta('q', { ...quiet, endpoints: ['https://a.test/x'], fetchImpl }),
  ).rejects.toThrow(/truncated answer.*Query timed out/)
})

test('um mirror truncado cede lugar ao próximo que responde completo', async () => {
  const fetchImpl = asFetch(async (url) =>
    url.startsWith('https://a.test')
      ? json({ elements: [{ id: 1 }], remark: 'runtime error: out of memory' })
      : json({ elements: [{ id: 1 }, { id: 2 }] }),
  )
  const r = await overpassQueryWithMeta<{ id: number }>('q', {
    ...quiet,
    endpoints: ['https://a.test/x', 'https://b.test/x'],
    fetchImpl,
  })
  expect(r.elements).toHaveLength(2)
})
