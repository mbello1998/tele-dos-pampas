import { describe, expect, test } from 'vitest'
import { cumulativeMeters, type Route } from '@/lib/geo/route'
import {
  estimar,
  MAX_DEDUZIDO_MS,
  PARAR_ANTES_M,
  SEM_SINAL_MS,
  textoChegada,
  velocidadeMedia,
  type Fix,
} from '@/lib/realtime/estimate'

/**
 * O motor que mantém o rastreio vivo quando o celular do motoboy sai do ar. O que estes testes protegem são
 * as três travas de honestidade — sem elas o plano B vira ficção, e rastreio que mente é pior que rastreio
 * que para.
 */

/** Uma reta de ~1 km para leste, sobre a qual é fácil conferir metros na mão. */
function rotaReta(): Route {
  const line = [
    { lat: -30.3861, lng: -56.4529 },
    { lat: -30.3861, lng: -56.4425 },
  ]
  const cumulative = cumulativeMeters(line)
  return { line, cumulative, meters: Math.round(cumulative[1]), seconds: 180, source: 'osrm', manobras: [] }
}

/** Leituras andando pela rota, `metros` por passo, a cada `segundos`. */
function leituras(rota: Route, passos: number, metros: number, segundos: number, fimMs = 0): Fix[] {
  const total = rota.meters
  const out: Fix[] = []
  for (let i = passos - 1; i >= 0; i--) {
    const along = Math.max(0, metros * (passos - 1 - i))
    const t = along / total
    out.push({
      lat: rota.line[0].lat + (rota.line[1].lat - rota.line[0].lat) * t,
      lng: rota.line[0].lng + (rota.line[1].lng - rota.line[0].lng) * t,
      atMs: fimMs - i * segundos * 1000,
    })
  }
  return out
}

describe('velocidadeMedia', () => {
  test('com uma leitura só, usa a velocidade de partida em vez de dividir por zero', () => {
    const rota = rotaReta()
    const v = velocidadeMedia([{ ...rota.line[0], atMs: 0 }], rota)
    expect(v).toBeGreaterThan(5)
    expect(v).toBeLessThan(10)
  })

  test('mede o deslocamento real: 60 m em 10 s dão ~6 m/s', () => {
    const rota = rotaReta()
    const v = velocidadeMedia(leituras(rota, 3, 60, 10), rota)
    expect(v).toBeGreaterThan(5)
    expect(v).toBeLessThan(7)
  })

  test('não aceita velocidade absurda de um salto de GPS', () => {
    const rota = rotaReta()
    // 900 m num segundo: erro de leitura, não moto. O teto impede que isso vire um tempo de chegada ridículo.
    const v = velocidadeMedia(
      [
        { ...rota.line[0], atMs: 0 },
        { ...rota.line[1], atMs: 1000 },
      ],
      rota,
    )
    expect(v).toBeLessThanOrEqual(60 / 3.6)
  })

  test('não aceita velocidade perto de zero de quem parou no semáforo', () => {
    const rota = rotaReta()
    const parado: Fix[] = [
      { ...rota.line[0], atMs: 0 },
      { ...rota.line[0], atMs: 30_000 },
    ]
    expect(velocidadeMedia(parado, rota)).toBeGreaterThanOrEqual(8 / 3.6)
  })
})

describe('estimar: ao vivo', () => {
  test('sem leitura nenhuma não há o que estimar', () => {
    expect(estimar([], rotaReta(), 0)).toBeNull()
  })

  test('com sinal, o ponteiro é a LEITURA CRUA, mesmo fora da rota', () => {
    const rota = rotaReta()
    // 200 m ao norte da rua: um atalho, um pátio, um posto.
    const fora: Fix = { lat: -30.3843, lng: -56.4477, atMs: 0 }
    const e = estimar([{ ...rota.line[0], atMs: -20_000 }, fora], rota, 0)!
    expect(e.sinal).toBe('ao_vivo')
    expect(e.posicao.lat).toBe(fora.lat)
    expect(e.posicao.lng).toBe(fora.lng)
    // A projeção continua existindo, para a linha e para a conta — só não manda no ponteiro.
    expect(e.naRota.lat).not.toBe(fora.lat)
    expect(e.foraDaRotaM).toBeGreaterThan(100)
  })

  test('o que falta é medido sobre a rota e diminui conforme anda', () => {
    const rota = rotaReta()
    const comeco = estimar(leituras(rota, 2, 50, 10), rota, 0)!
    const adiante = estimar(leituras(rota, 6, 50, 10), rota, 0)!
    expect(adiante.faltamMetros).toBeLessThan(comeco.faltamMetros)
  })
})

describe('estimar: o plano B', () => {
  test('passado o silêncio, o marcador ANDA sozinho pela rota', () => {
    const rota = rotaReta()
    const fixes = leituras(rota, 3, 60, 10)
    const parado = estimar(fixes, rota, 0)!
    const deduzido = estimar(fixes, rota, SEM_SINAL_MS + 20_000)!
    expect(parado.sinal).toBe('ao_vivo')
    expect(deduzido.sinal).toBe('estimado')
    expect(deduzido.faltamMetros).toBeLessThan(parado.faltamMetros)
  })

  test('TRAVA 1: depois do teto, para de deduzir — incerteza vira ficção', () => {
    const rota = rotaReta()
    const fixes = leituras(rota, 3, 60, 10)
    const noTeto = estimar(fixes, rota, MAX_DEDUZIDO_MS)!
    const muitoDepois = estimar(fixes, rota, MAX_DEDUZIDO_MS * 4)!
    expect(muitoDepois.sinal).toBe('perdido')
    // Andou o mesmo tanto: o tempo extra não moveu o marcador nem mais um metro.
    expect(muitoDepois.faltamMetros).toBe(noTeto.faltamMetros)
  })

  test('TRAVA 2: deduzindo de longe, o marcador para a 120 m e não "chega" sozinho', () => {
    const rota = rotaReta()
    // Medido lá atrás, silêncio longo: deduzindo à toa ele atravessaria o destino.
    const fixes = leituras(rota, 3, 60, 10)
    const e = estimar(fixes, rota, MAX_DEDUZIDO_MS)!
    expect(e.faltamMetros).toBeGreaterThanOrEqual(PARAR_ANTES_M - 1)
  })

  test('TRAVA 2: medido JÁ dentro dos 120 m, a dedução não move nada', () => {
    const rota = rotaReta()
    // O contrato é "nunca passar de máx(medido, destino − 120 m)": quando a própria medição já está mais
    // perto que isso, o marcador fica exatamente onde foi medido. Ele não anda, e também não volta atrás.
    const quaseLa = leituras(rota, 3, 60, 10).map((f) => ({ ...f, lat: rota.line[1].lat, lng: rota.line[1].lng - 0.0004 }))
    const medido = estimar(quaseLa, rota, 0)!
    const deduzido = estimar(quaseLa, rota, MAX_DEDUZIDO_MS)!
    expect(medido.faltamMetros).toBeLessThan(PARAR_ANTES_M)
    expect(deduzido.faltamMetros).toBe(medido.faltamMetros)
  })

  test('TRAVA 3: a média não se alimenta da própria dedução', () => {
    const rota = rotaReta()
    const fixes = leituras(rota, 3, 60, 10)
    // A velocidade é a mesma antes e depois do silêncio, porque só deslocamento MEDIDO entra na conta.
    expect(estimar(fixes, rota, MAX_DEDUZIDO_MS)!.velocidadeMs).toBeCloseTo(estimar(fixes, rota, 0)!.velocidadeMs, 6)
  })

  test('a contagem para o próximo sinal zera quando passa da hora', () => {
    const rota = rotaReta()
    const fixes = leituras(rota, 2, 60, 10)
    expect(estimar(fixes, rota, 3_000)!.proximaEmMs).toBeGreaterThan(0)
    expect(estimar(fixes, rota, 60_000)!.proximaEmMs).toBe(0)
  })
})

describe('textoChegada', () => {
  test('arredonda para cima: prometer menos e cumprir', () => {
    expect(textoChegada(61, 'pt-BR')).toBe('2 min')
    expect(textoChegada(119, 'pt-BR')).toBe('2 min')
    expect(textoChegada(121, 'pt-BR')).toBe('3 min')
  })

  test('menos de um minuto não vira "0 min"', () => {
    expect(textoChegada(10, 'pt-BR')).toBe('chega agora')
    expect(textoChegada(10, 'es-UY')).toBe('llega ahora')
  })
})
