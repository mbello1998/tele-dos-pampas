// tests/unit/interpolate.test.ts
// Rastreio (Tarefa 12), a parte que roda em Node: interpolação do marcador, o limitador (throttle) de envio
// da posição, a timeline e o radar. O que precisa de navegador de verdade (tiles que falham, página sem
// posição) está em tests/e2e/tracking.spec.ts; a privacidade, em tests/db/position-privacy.test.ts.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { haversineMeters } from '@/lib/geo/distance'
import type { LatLng } from '@/lib/geo/types'
import {
  bearingDegrees,
  createMarkerAnimator,
  createPositionPublisher,
  glideDurationMs,
  interpolatePosition,
  POSITION_MAX_ACCURACY_M,
  POSITION_MIN_DISTANCE_M,
  POSITION_MIN_INTERVAL_MS,
  TRACKING_ACTIVE_STATUSES,
} from '@/lib/realtime/position'

const root = resolve(__dirname, '../..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

const QUARAI: LatLng = { lat: -30.3875, lng: -56.4528 }
/** Ponto a `m` metros ao norte de `p` (1° de latitude ≈ 111 195 m na esfera do haversine do projeto). */
const north = (p: LatLng, m: number): LatLng => ({ lat: p.lat + m / 111_194.93, lng: p.lng })

// ---------------------------------------------------------------------------------------------
// interpolatePosition
// ---------------------------------------------------------------------------------------------
describe('interpolatePosition', () => {
  const a: LatLng = { lat: -30.39, lng: -56.45 }
  const b: LatLng = { lat: -30.37, lng: -56.43 }

  test('em t=0.5 retorna o ponto médio', () => {
    const mid = interpolatePosition(a, b, 0.5)
    expect(mid.lat).toBeCloseTo(-30.38, 9)
    expect(mid.lng).toBeCloseTo(-56.44, 9)
  })

  test('em t=0 e t=1 devolve as pontas, sem erro de arredondamento', () => {
    expect(interpolatePosition(a, b, 0)).toEqual(a)
    expect(interpolatePosition(a, b, 1)).toEqual(b)
  })

  test('t fora de [0, 1] não projeta o marcador para fora do trecho; t inválido fica na origem', () => {
    expect(interpolatePosition(a, b, -3)).toEqual(a)
    expect(interpolatePosition(a, b, 1.5)).toEqual(b)
    expect(interpolatePosition(a, b, 7)).toEqual(b)
    expect(interpolatePosition(a, b, -0.2)).toEqual(a)
    expect(interpolatePosition(a, b, Number.NaN)).toEqual(a)
  })

  test('a distância percorrida cresce linearmente com t', () => {
    const total = haversineMeters(a, b)
    for (const t of [0.1, 0.25, 0.75, 0.9]) {
      expect(haversineMeters(a, interpolatePosition(a, b, t))).toBeCloseTo(total * t, 0)
    }
  })

  test('bearingDegrees: norte é 0, leste é 90, sul é 180, oeste é 270', () => {
    expect(bearingDegrees(QUARAI, north(QUARAI, 100))).toBeCloseTo(0, 3)
    expect(bearingDegrees(QUARAI, { lat: QUARAI.lat, lng: QUARAI.lng + 0.001 })).toBeCloseTo(90, 1)
    expect(bearingDegrees(QUARAI, north(QUARAI, -100))).toBeCloseTo(180, 3)
    expect(bearingDegrees(QUARAI, { lat: QUARAI.lat, lng: QUARAI.lng - 0.001 })).toBeCloseTo(270, 1)
  })
})

// ---------------------------------------------------------------------------------------------
// O marcador anda entre pontos (requestAnimationFrame), nunca teleporta
// ---------------------------------------------------------------------------------------------
function fakeFrames() {
  let clock = 0
  let nextId = 1
  const pending = new Map<number, (ts: number) => void>()
  return {
    now: () => clock,
    raf: (cb: (ts: number) => void) => {
      const id = nextId++
      pending.set(id, cb)
      return id
    },
    caf: (id: number) => void pending.delete(id),
    get queued() {
      return pending.size
    },
    /** Avança o relógio em passos de `dt` ms, rodando os quadros pendentes. */
    run(ms: number, dt = 16) {
      for (let spent = 0; spent < ms; spent += dt) {
        clock += dt
        const batch = [...pending.entries()]
        pending.clear()
        for (const [, cb] of batch) cb(clock)
      }
    },
  }
}

describe('marcador: interpolação suave', () => {
  const A = QUARAI
  const B = north(QUARAI, 120)

  test('o primeiro ponto aparece onde está: não há de onde deslizar', () => {
    const f = fakeFrames()
    const seen: LatLng[] = []
    const m = createMarkerAnimator({ onFrame: (p) => seen.push(p), raf: f.raf, caf: f.caf, now: f.now })
    m.moveTo(A, 10_000)
    expect(seen).toEqual([A])
    expect(f.queued).toBe(0)
  })

  test('entre dois pontos passa por dezenas de posições intermediárias, em ordem, sem pular', () => {
    const f = fakeFrames()
    const seen: LatLng[] = []
    const m = createMarkerAnimator({ onFrame: (p) => seen.push(p), raf: f.raf, caf: f.caf, now: f.now })
    m.moveTo(A, 0)
    seen.length = 0
    m.moveTo(B, 1000)
    f.run(1200)

    expect(seen.length).toBeGreaterThan(40) // ~60 quadros em 1 s
    expect(seen.at(-1)).toEqual(B) // termina exatamente no ponto
    const total = haversineMeters(A, B)
    let prev = A
    for (const p of seen) {
      const step = haversineMeters(prev, p)
      expect(step, 'um quadro andou mais que o razoável (teleporte)').toBeLessThan(total / 40)
      expect(p.lat).toBeGreaterThanOrEqual(prev.lat - 1e-12) // só avança, nunca volta
      expect(p.lat).toBeLessThanOrEqual(B.lat + 1e-12)
      prev = p
    }
  })

  test('um ponto novo no meio do trecho parte de ONDE O MARCADOR ESTÁ, não do ponto anterior (sem salto)', () => {
    const f = fakeFrames()
    const seen: LatLng[] = []
    const m = createMarkerAnimator({ onFrame: (p) => seen.push(p), raf: f.raf, caf: f.caf, now: f.now })
    m.moveTo(A, 0)
    m.moveTo(B, 1000)
    f.run(480) // quase na metade
    const shown = seen.at(-1)!
    expect(haversineMeters(A, shown)).toBeGreaterThan(30)

    const C = north(B, 80)
    seen.length = 0
    m.moveTo(C, 1000)
    f.run(32)
    expect(seen.length).toBeGreaterThan(0)
    // o primeiro quadro depois do redirecionamento fica a poucos metros de onde estava, não perto de A
    expect(haversineMeters(shown, seen[0])).toBeLessThan(5)
    f.run(1200)
    expect(seen.at(-1)).toEqual(C)
  })

  test('com movimento reduzido (duração 0) o marcador vai direto, sem requestAnimationFrame', () => {
    const f = fakeFrames()
    const seen: LatLng[] = []
    const m = createMarkerAnimator({ onFrame: (p) => seen.push(p), raf: f.raf, caf: f.caf, now: f.now })
    m.moveTo(A, 0)
    m.moveTo(B, 0)
    expect(seen).toEqual([A, B])
    expect(f.queued).toBe(0)
  })

  test('stop() cancela o quadro pendente: nada roda depois de desmontar', () => {
    const f = fakeFrames()
    const seen: LatLng[] = []
    const m = createMarkerAnimator({ onFrame: (p) => seen.push(p), raf: f.raf, caf: f.caf, now: f.now })
    m.moveTo(A, 0)
    m.moveTo(B, 1000)
    f.run(100)
    m.stop()
    expect(f.queued).toBe(0)
    const n = seen.length
    f.run(2000)
    expect(seen.length).toBe(n)
  })

  test('a duração do deslize acompanha o intervalo entre os dois pontos, dentro de limites', () => {
    expect(glideDurationMs(1_000, 11_000)).toBe(10_000)
    expect(glideDurationMs(0, 100)).toBe(1_000) // muito curto: não pisca
    expect(glideDurationMs(0, 600_000)).toBe(12_000) // muito longo (ficou offline): não arrasta o marcador por minutos
    expect(glideDurationMs(5_000, 5_000)).toBe(1_000)
    expect(glideDurationMs(undefined, 5_000)).toBe(10_000) // sem referência: o ritmo de envio
    expect(glideDurationMs(9_000, 1_000)).toBe(10_000) // relógio andou para trás: ritmo de envio
  })

  test('o componente move o marcador só por transform: nunca por left/top', () => {
    const src = read('src/components/order/CourierMap.tsx')
    expect(src).toMatch(/style\.transform\s*=/)
    expect(src).not.toMatch(/style\.(left|top)\s*=/)
    expect(src).not.toMatch(/\b(left|top)\s*:\s*\$\{/) // posição por template de estilo
    expect(src).toContain('createMarkerAnimator')
  })
})

// ---------------------------------------------------------------------------------------------
// publishPosition: a cada ~10 s OU 30 m, o que vier primeiro
// ---------------------------------------------------------------------------------------------
describe('publishPosition: limitador de envio', () => {
  const ORDER = 'c0000000-0000-4000-8000-000000000001'

  function rig(overrides: Parameters<typeof createPositionPublisher>[1] = {}) {
    let clock = 0
    const sent: { orderId: string; lat: number; lng: number; at: number }[] = []
    const send = vi.fn(async (orderId: string, fix: LatLng) => {
      sent.push({ orderId, lat: fix.lat, lng: fix.lng, at: clock })
    })
    const pub = createPositionPublisher(send, { now: () => clock, ...overrides })
    return {
      pub,
      sent,
      send,
      at(ms: number) {
        clock = ms
      },
    }
  }

  test('constantes: 10 s, 30 m', () => {
    expect(POSITION_MIN_INTERVAL_MS).toBe(10_000)
    expect(POSITION_MIN_DISTANCE_M).toBe(30)
  })

  test('o primeiro ponto sempre é enviado', async () => {
    const r = rig()
    expect(await r.pub.publish(ORDER, QUARAI)).toBe('sent')
    expect(r.sent).toHaveLength(1)
  })

  test('descarta envio antes de 10 s e menos de 30 m', async () => {
    const r = rig()
    await r.pub.publish(ORDER, QUARAI)
    r.at(2_000)
    expect(await r.pub.publish(ORDER, north(QUARAI, 5))).toBe('throttled')
    r.at(9_999)
    expect(await r.pub.publish(ORDER, north(QUARAI, 29))).toBe('throttled')
    expect(r.sent).toHaveLength(1)
  })

  test('envia quando andou 30 m ou mais, mesmo antes dos 10 s', async () => {
    const r = rig()
    await r.pub.publish(ORDER, QUARAI)
    r.at(2_000)
    expect(await r.pub.publish(ORDER, north(QUARAI, 31))).toBe('sent')
    expect(r.sent).toHaveLength(2)
    expect(r.sent[1].at).toBe(2_000)
  })

  test('envia aos 10 s mesmo parado', async () => {
    const r = rig()
    await r.pub.publish(ORDER, QUARAI)
    r.at(10_000)
    expect(await r.pub.publish(ORDER, QUARAI)).toBe('sent')
    expect(r.sent).toHaveLength(2)
  })

  test('a referência é o último ponto ENVIADO: andar devagar também acaba passando dos 30 m', async () => {
    const r = rig()
    await r.pub.publish(ORDER, QUARAI)
    // 10,5 m a cada 1 s: cada passo sozinho não chega a 30 m, mas o acumulado desde o último envio chega
    const results: string[] = []
    for (let s = 1; s <= 4; s++) {
      r.at(s * 1_000)
      results.push(await r.pub.publish(ORDER, north(QUARAI, s * 10.5)))
    }
    expect(results).toEqual(['throttled', 'throttled', 'sent', 'throttled'])
  })

  test('fix impreciso (acurácia pior que o limite) é ignorado e não ocupa a vez do próximo', async () => {
    const r = rig()
    expect(POSITION_MAX_ACCURACY_M).toBe(100)
    expect(await r.pub.publish(ORDER, { ...QUARAI, accuracy_m: 450 })).toBe('inaccurate')
    expect(r.sent).toHaveLength(0)
    r.at(1_000)
    expect(await r.pub.publish(ORDER, { ...QUARAI, accuracy_m: 12 })).toBe('sent')
  })

  test('trocar de pedido envia na hora', async () => {
    const r = rig()
    await r.pub.publish(ORDER, QUARAI)
    r.at(500)
    expect(await r.pub.publish('c0000000-0000-4000-8000-000000000002', QUARAI)).toBe('sent')
  })

  test('falha de rede não derruba nada e não vira enxurrada de tentativas', async () => {
    let clock = 0
    const send = vi.fn(async () => {
      throw new Error('offline')
    })
    const pub = createPositionPublisher(send, { now: () => clock })
    expect(await pub.publish(ORDER, QUARAI)).toBe('failed')
    clock = 1_000
    expect(await pub.publish(ORDER, QUARAI)).toBe('throttled') // a tentativa conta para o intervalo
    clock = 10_000
    expect(await pub.publish(ORDER, QUARAI)).toBe('failed')
    expect(send).toHaveBeenCalledTimes(2)
  })

  test('um envio ainda em andamento não abre um segundo em paralelo', async () => {
    let clock = 0
    let release!: () => void
    const send = vi.fn(() => new Promise<void>((res) => (release = res)))
    const pub = createPositionPublisher(send, { now: () => clock })
    const first = pub.publish(ORDER, QUARAI)
    clock = 20_000
    expect(await pub.publish(ORDER, north(QUARAI, 500))).toBe('busy')
    release()
    expect(await first).toBe('sent')
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('relógio que andou para trás não trava o envio até "alcançar" o passado', async () => {
    const r = rig()
    r.at(100_000)
    await r.pub.publish(ORDER, QUARAI)
    r.at(50_000)
    expect(await r.pub.publish(ORDER, QUARAI)).toBe('sent')
  })

  // MEDIÇÃO. 1 fix por segundo (o ritmo comum do watchPosition) durante 10 minutos.
  test('medição: quantos envios em 10 minutos, parado, a pé, de moto e em disparada', async () => {
    const measure = async (metersPerSecond: number) => {
      const r = rig()
      for (let s = 0; s <= 600; s++) {
        r.at(s * 1_000)
        await r.pub.publish(ORDER, north(QUARAI, metersPerSecond * s))
      }
      return r.sent.length
    }
    const parado = await measure(0)
    const aPe = await measure(1.4) // 5 km/h: 30 m levam 21 s, então manda a cada 10 s
    const moto = await measure(8) // ~29 km/h: manda a cada 4 s (32 m)
    const disparada = await measure(12) // ~43 km/h: manda a cada 3 s (36 m)
    expect({ parado, aPe, moto, disparada }).toEqual({ parado: 61, aPe: 61, moto: 151, disparada: 201 })
    // Sem limitador seriam 601 envios por 10 min em qualquer cenário.
  })
})

// ---------------------------------------------------------------------------------------------
// Timeline: construída a partir de order_events, em ordem
// ---------------------------------------------------------------------------------------------
describe('StatusTimeline', () => {
  const labels = {
    criado: 'Pedido criado',
    aguardando_motoboy: 'Procurando motoboy',
    aceito: 'Motoboy a caminho',
    coletado: 'Coletado',
    entregue: 'Entregue',
  }

  test('a timeline é construída a partir de order_events, em ordem cronológica, mesmo que cheguem fora de ordem', async () => {
    const { StatusTimeline } = await import('@/components/order/StatusTimeline')
    const events = [
      { id: 4, from_status: 'coletado', to_status: 'entregue', created_at: '2026-11-10T15:30:00Z' },
      { id: 1, from_status: null, to_status: 'criado', created_at: '2026-11-10T15:00:00Z' },
      { id: 3, from_status: 'aceito', to_status: 'coletado', created_at: '2026-11-10T15:20:00Z' },
      { id: 2, from_status: 'criado', to_status: 'aceito', created_at: '2026-11-10T15:10:00Z' },
    ]
    const html = renderToStaticMarkup(createElement(StatusTimeline, { events, labels, locale: 'pt-BR' }))
    const order = [...html.matchAll(/data-status="([a-z_]+)"/g)].map((m) => m[1])
    expect(order).toEqual(['criado', 'aceito', 'coletado', 'entregue'])
    // o texto vem do evento, não de um passo inventado
    for (const text of ['Pedido criado', 'Motoboy a caminho', 'Coletado', 'Entregue']) expect(html).toContain(text)
    expect(html).not.toContain('Procurando motoboy') // não aconteceu: não aparece
    // a hora é exibida no fuso das duas cidades (UTC-3), não no do servidor
    expect(html).toContain('12:00')
    expect(html).toContain('12:30')
  })

  test('eventos no mesmo instante respeitam o id (a ordem de gravação)', async () => {
    const { StatusTimeline } = await import('@/components/order/StatusTimeline')
    const same = '2026-11-10T15:00:00Z'
    const html = renderToStaticMarkup(
      createElement(StatusTimeline, {
        events: [
          { id: 9, from_status: 'criado', to_status: 'aguardando_motoboy', created_at: same },
          { id: 8, from_status: null, to_status: 'criado', created_at: same },
        ],
        labels,
        locale: 'pt-BR',
      }),
    )
    expect([...html.matchAll(/data-status="([a-z_]+)"/g)].map((m) => m[1])).toEqual(['criado', 'aguardando_motoboy'])
  })

  test('sem evento nenhum não quebra e diz que está aguardando', async () => {
    const { StatusTimeline } = await import('@/components/order/StatusTimeline')
    const html = renderToStaticMarkup(
      createElement(StatusTimeline, { events: [], labels, locale: 'pt-BR', emptyLabel: 'Aguardando o primeiro registro' }),
    )
    expect(html).toContain('Aguardando o primeiro registro')
    expect(html).not.toContain('data-status')
  })

  test('o último evento fica marcado como o passo atual (aria-current)', async () => {
    const { StatusTimeline } = await import('@/components/order/StatusTimeline')
    const html = renderToStaticMarkup(
      createElement(StatusTimeline, {
        events: [
          { id: 1, from_status: null, to_status: 'criado', created_at: '2026-11-10T15:00:00Z' },
          { id: 2, from_status: 'criado', to_status: 'aceito', created_at: '2026-11-10T15:10:00Z' },
        ],
        labels,
        locale: 'pt-BR',
      }),
    )
    expect(html.match(/aria-current="step"/g)).toHaveLength(1)
    expect(html.indexOf('aria-current="step"')).toBeGreaterThan(html.indexOf('data-status="criado"'))
    expect(html.indexOf('aria-current="step"')).toBeGreaterThan(html.indexOf('data-status="aceito"') - 40)
  })
})

// ---------------------------------------------------------------------------------------------
// SearchingRadar: SVG + GSAP; só transform e opacity (e strokeDashoffset, no preset da malha)
// ---------------------------------------------------------------------------------------------
describe('SearchingRadar', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('gsap')
    vi.doUnmock('gsap/ScrollTrigger')
    vi.doUnmock('lenis')
    vi.resetModules()
  })

  const ANIMAVEIS = new Set(['opacity', 'autoAlpha', 'x', 'y', 'xPercent', 'yPercent', 'scale', 'scaleX', 'scaleY', 'rotation'])
  const CONTROLE = new Set([
    'duration', 'delay', 'ease', 'stagger', 'overwrite', 'immediateRender', 'paused', 'repeat', 'repeatDelay', 'yoyo',
    'transformOrigin', 'svgOrigin', 'force3D', 'clearProps', 'lazy', 'defaults', 'onComplete', 'each', 'from', 'amount',
  ])

  function stubBrowser(reducedMotion: boolean) {
    vi.stubGlobal('window', {
      matchMedia: (q: string) => ({
        matches: q.includes('prefers-reduced-motion: reduce') ? reducedMotion : false,
        media: q,
        addEventListener() {},
        removeEventListener() {},
      }),
    })
    vi.stubGlobal('navigator', { connection: { saveData: false, effectiveType: '4g' } })
  }

  function mockMotion() {
    const loaded: string[] = []
    const tweens: { target: unknown; vars: Record<string, unknown> }[] = []
    const rec = (target: unknown, ...vars: Array<Record<string, unknown> | undefined>) => {
      for (const v of vars) if (v) tweens.push({ target, vars: v })
    }
    vi.doMock('gsap', () => {
      loaded.push('gsap')
      const timeline = () => {
        const tl = {
          to: (t: unknown, v: Record<string, unknown>) => (rec(t, v), tl),
          from: (t: unknown, v: Record<string, unknown>) => (rec(t, v), tl),
          fromTo: (t: unknown, a: Record<string, unknown>, b: Record<string, unknown>) => (rec(t, a, b), tl),
          set: (t: unknown, v: Record<string, unknown>) => (rec(t, v), tl),
          kill() {},
        }
        return tl
      }
      const gsap = {
        registerPlugin() {},
        context: (fn: () => void) => (fn(), { revert() {} }),
        timeline,
        to: (t: unknown, v: Record<string, unknown>) => rec(t, v),
        from: (t: unknown, v: Record<string, unknown>) => rec(t, v),
        fromTo: (t: unknown, a: Record<string, unknown>, b: Record<string, unknown>) => rec(t, a, b),
        set: (t: unknown, v: Record<string, unknown>) => rec(t, v),
      }
      return { gsap, default: gsap }
    })
    vi.doMock('gsap/ScrollTrigger', () => {
      loaded.push('ScrollTrigger')
      return { ScrollTrigger: {}, default: {} }
    })
    vi.doMock('lenis', () => {
      loaded.push('lenis')
      return { default: class {} }
    })
    return { loaded, tweens }
  }

  const fakeRoot = () => ({
    querySelector: (sel: string) => ({ sel }),
    querySelectorAll: (sel: string) => [{ sel }],
  })

  test('o HTML do servidor já tem o conteúdo: texto de estado, SVG, e nada de vídeo', async () => {
    const { SearchingRadar } = await import('@/components/order/SearchingRadar')
    const html = renderToStaticMarkup(createElement(SearchingRadar, { label: 'Procurando um motoboy perto de você', hint: 'Isso costuma levar poucos minutos' }))
    expect(html).toContain('Procurando um motoboy perto de você')
    expect(html).toContain('Isso costuma levar poucos minutos')
    expect(html).toContain('<svg')
    expect(html).toMatch(/role="status"/)
    expect(html).not.toMatch(/<video|<canvas|<iframe/)
  })

  test('com prefers-reduced-motion não carrega GSAP, ScrollTrigger nem Lenis, e o conteúdo segue lá', async () => {
    stubBrowser(true)
    const { loaded, tweens } = mockMotion()
    const mod = await import('@/components/order/SearchingRadar')
    const stop = await mod.playRadar(fakeRoot() as unknown as Element)
    expect(typeof stop).toBe('function')
    stop()
    expect(loaded).toEqual([])
    expect(tweens).toEqual([])
    const html = renderToStaticMarkup(createElement(mod.SearchingRadar, { label: 'Procurando' }))
    expect(html).toContain('Procurando')
  })

  test('com movimento liberado anima só transform e opacity, e strokeDashoffset só na malha, pelo preset gridStroke', async () => {
    stubBrowser(false)
    const { loaded, tweens } = mockMotion()
    const mod = await import('@/components/order/SearchingRadar')
    const stop = await mod.playRadar(fakeRoot() as unknown as Element)
    stop()
    expect(loaded).toContain('gsap')
    expect(loaded).not.toContain('lenis') // o radar nunca rola a página

    expect(tweens.length).toBeGreaterThan(3)
    const keys = new Set(tweens.flatMap((t) => Object.keys(t.vars)))
    const intrusas = [...keys].filter((k) => !ANIMAVEIS.has(k) && !CONTROLE.has(k) && k !== 'strokeDashoffset')
    expect(intrusas, 'propriedade fora de transform/opacity').toEqual([])

    const dash = tweens.filter((t) => 'strokeDashoffset' in t.vars)
    expect(dash.length).toBeGreaterThan(0)
    for (const t of dash) expect(String((t.target as { sel: string }).sel)).toMatch(/data-mesh/)

    // e o que há de movimento ali (varredura, pulso) é rotação, escala e opacidade
    const moving = tweens.filter((t) => !('strokeDashoffset' in t.vars))
    expect(moving.some((t) => 'rotation' in t.vars)).toBe(true)
    expect(moving.some((t) => 'scale' in t.vars || 'opacity' in t.vars)).toBe(true)

    const { presets } = await import('@/lib/motion/presets')
    expect(dash.some((t) => t.vars.strokeDashoffset === presets.gridStroke.to.strokeDashoffset)).toBe(true)
  })

  test('com economia de dados também não anima nem carrega nada', async () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
    vi.stubGlobal('navigator', { connection: { saveData: true, effectiveType: '4g' } })
    const { loaded } = mockMotion()
    const mod = await import('@/components/order/SearchingRadar')
    ;(await mod.playRadar(fakeRoot() as unknown as Element))()
    expect(loaded).toEqual([])
  })

  test('a fonte do radar não importa gsap/lenis direto (só pelo carregador) e não escreve strokeDashoffset', () => {
    const src = read('src/components/order/SearchingRadar.tsx')
    expect(src).not.toMatch(/from ['"]gsap/)
    expect(src).not.toMatch(/import\(\s*['"]gsap/)
    expect(src).not.toMatch(/lenis/i)
    expect(src).toContain('loadMotion')
    expect(src).toContain('presets.gridStroke')
    // strokeDashoffset: nenhuma ocorrência fora de comentário; quem tem a palavra é o preset
    const semComentarios = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(semComentarios).not.toMatch(/strokeDashoffset|stroke-dashoffset/)
    // a malha vem da versão de 10 kB, nunca dos datasets completos
    expect(src).toContain('/data/grid-simplified.json')
    expect(src).not.toMatch(/\/data\/(quarai|artigas)\.json/)
  })
})

// ---------------------------------------------------------------------------------------------
// CourierMap: o que dá para provar sem navegador
// ---------------------------------------------------------------------------------------------
describe('CourierMap', () => {
  test('o modelo de URL do provedor é preenchido com {z}/{x}/{y} e opcionalmente {s} e {r}', async () => {
    const { tileUrl } = await import('@/components/order/CourierMap')
    expect(tileUrl('https://tile.example/{z}/{x}/{y}.png', 16, 22345, 36789)).toBe('https://tile.example/16/22345/36789.png')
    expect(tileUrl('https://{s}.tiles.example/{z}/{x}/{y}{r}.png', 3, 1, 2)).toBe('https://a.tiles.example/3/1/2.png')
  })

  test('projeção Web Mercator: (0,0) no zoom 0 cai no centro do mundo de 256 px', async () => {
    const { toWorldPx } = await import('@/components/order/CourierMap')
    const p = toWorldPx({ lat: 0, lng: 0 }, 0)
    expect(p.x).toBeCloseTo(128, 6)
    expect(p.y).toBeCloseTo(128, 6)
    // cada nível de zoom dobra a escala
    const q = toWorldPx({ lat: QUARAI.lat, lng: QUARAI.lng }, 16)
    const r = toWorldPx({ lat: QUARAI.lat, lng: QUARAI.lng }, 17)
    expect(r.x).toBeCloseTo(q.x * 2, 6)
    expect(r.y).toBeCloseTo(q.y * 2, 6)
  })

  test('o zoom encaixa motoboy e destino na tela: mais perto, mais zoom; sempre entre 13 e 17', async () => {
    const { fitZoom } = await import('@/components/order/CourierMap')
    const size = { width: 360, height: 270 }
    const perto = fitZoom([QUARAI, north(QUARAI, 150)], size)
    const longe = fitZoom([QUARAI, north(QUARAI, 4000)], size)
    expect(perto).toBeGreaterThan(longe)
    expect(perto).toBeLessThanOrEqual(17)
    expect(fitZoom([QUARAI, north(QUARAI, 80_000)], size)).toBe(13)
    expect(fitZoom([QUARAI], size)).toBe(17)
  })

  test('sem URL de tiles (setting ausente) mostra o endereço em texto e nenhuma imagem', async () => {
    const { CourierMap } = await import('@/components/order/CourierMap')
    const html = renderToStaticMarkup(
      createElement(CourierMap, {
        tileUrlTemplate: null,
        courier: { ...QUARAI },
        destination: north(QUARAI, 300),
        addressText: 'Rua Uruguai, 120 — Quaraí',
        labels: { unavailable: 'Mapa indisponível', courier: 'Motoboy', distance: 'a {m} m de você', showMap: 'Mostrar mapa' },
      }),
    )
    expect(html).toContain('Rua Uruguai, 120')
    expect(html).toContain('Mapa indisponível')
    expect(html).not.toContain('<img')
  })
})

test('os status de rastreio ativos são exatamente os que têm motoboy a caminho', () => {
  expect([...TRACKING_ACTIVE_STATUSES].sort()).toEqual(
    ['aceito', 'coletado', 'em_preparo', 'em_rota', 'em_viagem', 'motoboy_chegou', 'pronto'].sort(),
  )
})
