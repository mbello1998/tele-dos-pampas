import { describe, expect, test } from 'vitest'
import {
  cumulativeMeters,
  pointAt,
  projectOnto,
  remainingLine,
  remainingMeters,
  straightRoute,
  type Route,
} from '@/lib/geo/route'

/**
 * A rota é o que faz o marcador andar pela rua em vez de cortar quarteirão. Os testes abaixo usam uma rota
 * em "L" — duas retas e uma esquina — porque é a forma mais simples em que cortar caminho dá um resultado
 * DIFERENTE de seguir a rua. Numa rota reta os dois seriam iguais e o teste não provaria nada.
 */

/** Um L: 1 km para leste, depois ~0,44 km para o norte. Coordenadas de Quaraí. */
function rotaEmL(): Route {
  const line = [
    { lat: -30.3861, lng: -56.4529 },
    { lat: -30.3861, lng: -56.4425 }, // ~1 km a leste
    { lat: -30.3821, lng: -56.4425 }, // ~0,44 km ao norte
  ]
  const cumulative = cumulativeMeters(line)
  return { line, cumulative, meters: Math.round(cumulative[2]), seconds: 240, source: 'osrm', manobras: [] }
}

describe('cumulativeMeters', () => {
  test('começa em zero e cresce a cada vértice', () => {
    const c = cumulativeMeters(rotaEmL().line)
    expect(c[0]).toBe(0)
    expect(c[1]).toBeGreaterThan(900)
    expect(c[2]).toBeGreaterThan(c[1])
  })

  test('um ponto só não tem distância', () => {
    expect(cumulativeMeters([{ lat: -30.38, lng: -56.45 }])).toEqual([0])
  })
})

describe('projectOnto: grudar o GPS na rua', () => {
  test('um ponto fora da rota cai no trecho mais próximo, não no vértice mais próximo', () => {
    const rota = rotaEmL()
    // No meio da primeira reta, 50 m ao norte dela.
    const p = projectOnto(rota, { lat: -30.3857, lng: -56.4477 })
    expect(p.offMeters).toBeGreaterThan(30)
    expect(p.offMeters).toBeLessThan(70)
    // Caiu NO MEIO do primeiro trecho: é isso que um vértice mais próximo não daria.
    expect(p.metersAlong).toBeGreaterThan(400)
    expect(p.metersAlong).toBeLessThan(700)
    expect(p.snapped.lat).toBeCloseTo(-30.3861, 3)
  })

  test('um ponto em cima da rota tem desvio quase zero', () => {
    const rota = rotaEmL()
    const p = projectOnto(rota, rota.line[1])
    expect(p.offMeters).toBeLessThan(1)
    expect(p.metersAlong).toBeCloseTo(rota.cumulative[1], 0)
  })

  test('o desvio cresce com a distância da rua: é o sinal de que pegou outro caminho', () => {
    const rota = rotaEmL()
    const perto = projectOnto(rota, { lat: -30.3858, lng: -56.4477 })
    const longe = projectOnto(rota, { lat: -30.3800, lng: -56.4477 })
    expect(longe.offMeters).toBeGreaterThan(perto.offMeters * 5)
  })
})

describe('pointAt e o que falta', () => {
  test('nas pontas devolve as pontas, e nunca extrapola', () => {
    const rota = rotaEmL()
    expect(pointAt(rota, -500)).toEqual(rota.line[0])
    expect(pointAt(rota, rota.meters + 500)).toEqual(rota.line[2])
  })

  test('na esquina devolve a esquina', () => {
    const rota = rotaEmL()
    const p = pointAt(rota, rota.cumulative[1])
    expect(p.lat).toBeCloseTo(rota.line[1].lat, 5)
    expect(p.lng).toBeCloseTo(rota.line[1].lng, 5)
  })

  test('o que falta é medido PELA RUA, e é maior que a linha reta num L', () => {
    const rota = rotaEmL()
    const faltam = remainingMeters(rota, 0)
    expect(faltam).toBe(rota.meters)
    // A hipotenusa do L é bem menor que os dois catetos somados: é exatamente o erro que medir em linha
    // reta cometeria, e a razão de a conta ser feita sobre a rota.
    const retaAproximada = Math.hypot(1000, 440)
    expect(faltam).toBeGreaterThan(retaAproximada + 100)
  })

  test('nunca é negativo, mesmo passando do fim', () => {
    const rota = rotaEmL()
    expect(remainingMeters(rota, rota.meters + 999)).toBe(0)
  })
})

describe('remainingLine: o trecho aceso no mapa', () => {
  test('começa onde a pessoa está e termina no destino', () => {
    const rota = rotaEmL()
    const adiante = remainingLine(rota, 500)
    expect(adiante.length).toBeGreaterThanOrEqual(2)
    expect(adiante[adiante.length - 1]).toEqual(rota.line[2])
    // O primeiro ponto é o lugar exato, não o vértice anterior.
    expect(adiante[0].lng).toBeGreaterThan(rota.line[0].lng)
    expect(adiante[0].lng).toBeLessThan(rota.line[1].lng)
  })

  test('do começo, é a rota inteira', () => {
    const rota = rotaEmL()
    expect(remainingLine(rota, 0)).toEqual(rota.line)
  })
})

describe('straightRoute: o que sobra quando o roteador não responde', () => {
  test('tem dois pontos, distância maior que a reta e marca a origem', () => {
    const a = { lat: -30.3861, lng: -56.4529 }
    const b = { lat: -30.3821, lng: -56.4395 }
    const r = straightRoute(a, b)
    expect(r.source).toBe('reta')
    expect(r.line).toEqual([a, b])
    expect(r.manobras).toEqual([])
    // O fator de malha urbana: a rota reta nunca promete a distância da linha reta pura.
    expect(r.meters).toBeGreaterThan(1300)
    expect(r.seconds).toBeGreaterThan(0)
  })
})
