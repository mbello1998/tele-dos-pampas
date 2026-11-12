import { describe, expect, test } from 'vitest'
import { distanciaFalada, manobraSeguinte, proximaManobra } from '@/lib/geo/manobra'
import { cumulativeMeters, type Manobra, type Route } from '@/lib/geo/route'

/**
 * A navegação é lida a 40 km/h, de capacete. O que estes testes protegem é isso: uma instrução por vez, na
 * hora certa, sem número que ninguém consegue estimar com o olho.
 */

function rotaCom(manobras: Manobra[]): Route {
  const line = [
    { lat: -30.3861, lng: -56.4529 },
    { lat: -30.3861, lng: -56.4425 },
  ]
  const cumulative = cumulativeMeters(line)
  return { line, cumulative, meters: Math.round(cumulative[1]), seconds: 180, source: 'osrm', manobras }
}

const CURVAS: Manobra[] = [
  { atMeters: 300, type: 'turn', modifier: 'right', street: 'Rua dos Andradas' },
  { atMeters: 700, type: 'turn', modifier: 'left', street: 'Avenida Brasil' },
  { atMeters: 1000, type: 'arrive', modifier: '', street: '' },
]

describe('distanciaFalada: como se fala, não como se mede', () => {
  test('arredonda para a dezena perto e para a cinquentena longe', () => {
    expect(distanciaFalada(37, 'pt-BR')).toBe('40 m')
    expect(distanciaFalada(347, 'pt-BR')).toBe('350 m')
    expect(distanciaFalada(372, 'pt-BR')).toBe('350 m')
  })

  test('nunca diz "0 m": abaixo de 10 m já é a esquina', () => {
    expect(distanciaFalada(3, 'pt-BR')).toBe('10 m')
  })

  test('passa para quilômetro com uma casa, com vírgula', () => {
    expect(distanciaFalada(1240, 'pt-BR')).toBe('1,2 km')
  })
})

describe('proximaManobra', () => {
  test('sem curva pela frente, não há instrução', () => {
    expect(proximaManobra(rotaCom([]), 0, 'pt-BR')).toBeNull()
    // Passou de todas: idem.
    expect(proximaManobra(rotaCom(CURVAS), 1500, 'pt-BR')).toBeNull()
  })

  test('anuncia a PRÓXIMA, com a distância até ela', () => {
    const i = proximaManobra(rotaCom(CURVAS), 100, 'pt-BR')!
    expect(i.metros).toBe(200)
    expect(i.texto).toBe('Em 200 m, vire à direita na Rua dos Andradas')
    expect(i.agora).toBe(false)
  })

  test('a curva já passada sai da frente: a seguinte assume', () => {
    const i = proximaManobra(rotaCom(CURVAS), 400, 'pt-BR')!
    expect(i.manobra.street).toBe('Avenida Brasil')
    expect(i.texto).toContain('à esquerda')
  })

  test('em cima da esquina troca para "agora" e acende', () => {
    const i = proximaManobra(rotaCom(CURVAS), 290, 'pt-BR')!
    expect(i.agora).toBe(true)
    expect(i.texto).toBe('Vire à direita na Rua dos Andradas agora')
    // Já não conta metros: a essa distância não dá tempo de ler um número e decidir.
    expect(i.texto).not.toMatch(/\d+\s?m/)
  })

  test('rua sem nome não vira "vire à direita em \'\'"', () => {
    const semNome: Manobra[] = [{ atMeters: 200, type: 'turn', modifier: 'left', street: '' }]
    const i = proximaManobra(rotaCom(semNome), 0, 'pt-BR')!
    expect(i.texto).toBe('Em 200 m, vire à esquerda')
  })

  test('a chegada de longe é anunciada no futuro, não no passado', () => {
    // "Em 200 m, chegou ao destino" mistura futuro com passado e soa como erro de tradução.
    const i = proximaManobra(rotaCom(CURVAS), 800, 'pt-BR')!
    expect(i.texto).toBe('Em 200 m, você chega ao destino')
  })

  test('a chegada em cima do ponto vira passado, sem "agora" redundante', () => {
    const i = proximaManobra(rotaCom(CURVAS), 990, 'pt-BR')!
    expect(i.texto).toBe('Chegou ao destino')
  })

  test('em espanhol usa o verbo do lado de lá do rio', () => {
    const i = proximaManobra(rotaCom(CURVAS), 100, 'es-UY')!
    expect(i.texto).toBe('En 200 m, doblá a la derecha en Rua dos Andradas')
  })
})

describe('manobraSeguinte: a curva depois da próxima', () => {
  test('mostra a de depois, que é o que evita a troca de faixa de última hora', () => {
    expect(manobraSeguinte(rotaCom(CURVAS), 100, 'pt-BR')).toBe('Vire à esquerda na Avenida Brasil')
  })

  test('na última curva não há "depois"', () => {
    expect(manobraSeguinte(rotaCom(CURVAS), 800, 'pt-BR')).toBeNull()
  })
})
