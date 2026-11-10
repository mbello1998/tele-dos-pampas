import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { haversineMeters } from '@/lib/geo/distance'
import { routeDistance } from '@/lib/geo/osrm'
import type { LatLng } from '@/lib/geo/types'
import type { RouteSource } from '@/lib/pricing/types'

// City centres: the median latitude and the median longitude over every vertex
// of every street in public/data/{quarai,artigas}.json (1992 and 3682 points).
// The bounding-box centre is useless here: both datasets include rural roads
// that stretch the box tens of kilometres.
const QUARAI: LatLng = { lat: -30.37911, lng: -56.45136 }
const ARTIGAS: LatLng = { lat: -30.41186, lng: -56.46895 }
// Geodesic distance between those two points on the WGS-84 ellipsoid, computed
// independently with Vincenty's inverse formula (not with haversine).
const EXPECTED_GEODESIC_M = 4004.9

const HAVERSINE_FACTOR = 1.35

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const osrmOk = (distance: number): Response =>
  jsonResponse({ code: 'Ok', routes: [{ distance, duration: 100 }] })

const expectedFallback = (): number =>
  Math.round(haversineMeters(QUARAI, ARTIGAS) * HAVERSINE_FACTOR)

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('haversineMeters', () => {
  it('Quarai centre to Artigas centre matches the geodesic value within 2%', () => {
    const d = haversineMeters(QUARAI, ARTIGAS)
    expect(Math.abs(d - EXPECTED_GEODESIC_M) / EXPECTED_GEODESIC_M).toBeLessThan(0.02)
  })

  it('is symmetric', () => {
    expect(haversineMeters(QUARAI, ARTIGAS)).toBe(haversineMeters(ARTIGAS, QUARAI))
  })

  it('returns exactly 0 for identical points, never NaN', () => {
    const d = haversineMeters(QUARAI, QUARAI)
    expect(d).toBe(0)
    expect(Number.isNaN(d)).toBe(false)
  })

  it('stays finite for antipodal points (rounding can push the sqrt argument past 1)', () => {
    const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 180 })
    expect(Number.isFinite(d)).toBe(true)
    expect(d).toBeGreaterThan(20_000_000)
  })
})

describe('routeDistance', () => {
  it('uses the OSRM distance as-is, rounded, without the 1.35 factor', async () => {
    fetchMock.mockResolvedValue(osrmOk(5234.6))
    const r = await routeDistance(QUARAI, ARTIGAS)
    expect(r).toEqual({ meters: 5235, source: 'osrm' })
    expect(r.meters).not.toBe(expectedFallback())
  })

  it('asks OSRM in lng,lat order and passes an abort signal', async () => {
    fetchMock.mockResolvedValue(osrmOk(100))
    await routeDistance(QUARAI, ARTIGAS)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('router.project-osrm.org/route/v1/driving/')
    expect(url).toContain('-56.45136,-30.37911;-56.46895,-30.41186')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('falls back to haversine x 1.35 when the network fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const r = await routeDistance(QUARAI, ARTIGAS)
    const source: RouteSource = 'haversine'
    expect(r.source).toBe(source)
    expect(r.meters).toBe(expectedFallback())
    expect(Number.isInteger(r.meters)).toBe(true)
  })

  it('falls back when fetch throws synchronously', async () => {
    fetchMock.mockImplementation(() => {
      throw new Error('boom')
    })
    const r = await routeDistance(QUARAI, ARTIGAS)
    expect(r.source).toBe('haversine')
  })

  it('falls back on a non-200 status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'Ok', routes: [{ distance: 999 }] }, 503))
    const r = await routeDistance(QUARAI, ARTIGAS)
    expect(r.source).toBe('haversine')
    expect(r.meters).toBe(expectedFallback())
  })

  it.each([
    ['empty object', {}],
    ['code not Ok', { code: 'NoRoute', routes: [] }],
    ['empty routes', { code: 'Ok', routes: [] }],
    ['routes not an array', { code: 'Ok', routes: 'x' }],
    ['distance missing', { code: 'Ok', routes: [{ duration: 5 }] }],
    ['distance is a string', { code: 'Ok', routes: [{ distance: '5000' }] }],
    ['distance negative', { code: 'Ok', routes: [{ distance: -1 }] }],
    ['null body', null],
    ['array body', [1, 2]],
  ])('falls back on a 200 with the wrong shape: %s', async (_label, body) => {
    fetchMock.mockResolvedValue(jsonResponse(body))
    const r = await routeDistance(QUARAI, ARTIGAS)
    expect(r.source).toBe('haversine')
    expect(r.meters).toBe(expectedFallback())
  })

  it('falls back on a 200 whose body is not JSON', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>Bad gateway page</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    )
    const r = await routeDistance(QUARAI, ARTIGAS)
    expect(r.source).toBe('haversine')
    expect(r.meters).toBe(expectedFallback())
  })

  it('identical origin and destination yields 0, not NaN, when OSRM is down', async () => {
    fetchMock.mockRejectedValue(new Error('down'))
    const r = await routeDistance(QUARAI, QUARAI)
    expect(r).toEqual({ meters: 0, source: 'haversine' })
  })

  it('aborts an OSRM response slower than 3 s and falls back', async () => {
    vi.useFakeTimers()
    let aborted = false
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    )
    const pending = routeDistance(QUARAI, ARTIGAS)

    await vi.advanceTimersByTimeAsync(2999)
    expect(aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(aborted).toBe(true)
    const r = await pending
    expect(r.source).toBe('haversine')
    expect(r.meters).toBe(expectedFallback())
  })

  it('also times out when the headers arrive but the body stalls', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('aborted', 'AbortError')),
          )
        },
      })
      return Promise.resolve(new Response(stream, { status: 200 }))
    })
    const pending = routeDistance(QUARAI, ARTIGAS)
    await vi.advanceTimersByTimeAsync(3000)
    const r = await pending
    expect(r.source).toBe('haversine')
  })

  it('does not abort a fast response and leaves no timer behind', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(osrmOk(4321))
    const r = await routeDistance(QUARAI, ARTIGAS)
    expect(r).toEqual({ meters: 4321, source: 'osrm' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
