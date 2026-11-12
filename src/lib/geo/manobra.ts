import type { Manobra, Route } from './route'

/**
 * "EM 200 M, VIRE À DIREITA NA RUA DOS ANDRADAS."
 *
 * A dinâmica é a do Waze, e ela é a razão de aquilo funcionar numa moto: UMA instrução por vez, a próxima
 * sempre visível, e a distância encolhendo. O motoboy não lê uma lista de dez passos a 40 km/h — ele olha
 * meio segundo no semáforo e precisa sair sabendo a próxima curva.
 *
 * Três decisões que vêm junto:
 *   - a distância é arredondada como se fala, não como se mede: 350 m, não 347 m. Precisão falsa num número
 *     que a pessoa vai estimar com o olho não ajuda ninguém;
 *   - perto da curva o texto troca de "em 80 m, vire" para "VIRE AGORA". Metro a metro, em cima da esquina,
 *     é tarde para ler;
 *   - rua sem nome não vira "vire à direita em ''": vira só "vire à direita". O OSRM não conhece o nome de
 *     toda rua de Quaraí, e metade das ruas de chão não tem placa.
 */

export type Locale = 'pt-BR' | 'es-UY'

/** Em cima da curva: para de contar metros e manda virar. */
const AGORA_M = 25

const LADO: Record<Locale, Record<string, string>> = {
  'pt-BR': {
    left: 'à esquerda',
    right: 'à direita',
    'slight left': 'levemente à esquerda',
    'slight right': 'levemente à direita',
    'sharp left': 'à esquerda, fechado',
    'sharp right': 'à direita, fechado',
    straight: 'em frente',
    uturn: 'em sentido contrário',
  },
  'es-UY': {
    left: 'a la izquierda',
    right: 'a la derecha',
    'slight left': 'levemente a la izquierda',
    'slight right': 'levemente a la derecha',
    'sharp left': 'a la izquierda, cerrado',
    'sharp right': 'a la derecha, cerrado',
    straight: 'derecho',
    uturn: 'en sentido contrario',
  },
}

const VERBO: Record<Locale, { turn: string; continue: string; roundabout: string; fork: string; merge: string; arrive: string; on: string; now: string; in: string }> = {
  'pt-BR': { turn: 'Vire', continue: 'Siga', roundabout: 'Na rotatória, saia', fork: 'Mantenha-se', merge: 'Entre', arrive: 'Chegou', on: 'na', now: 'agora', in: 'Em' },
  'es-UY': { turn: 'Doblá', continue: 'Seguí', roundabout: 'En la rotonda, salí', fork: 'Mantenete', merge: 'Entrá', arrive: 'Llegaste', on: 'en', now: 'ahora', in: 'En' },
}

/** 347 -> "350 m"; 1240 -> "1,2 km". Como se fala, não como se mede. */
export function distanciaFalada(metros: number, locale: Locale): string {
  if (metros >= 1000) return `${(metros / 1000).toFixed(1).replace('.', ',')} km`
  if (metros >= 100) return `${Math.round(metros / 50) * 50} m`
  return `${Math.max(10, Math.round(metros / 10) * 10)} m`
}

/**
 * O miolo da instrução, sem a distância: "vire à direita na Rua dos Andradas".
 *
 * `agora` muda o TEMPO VERBAL da chegada, e só dela: "em 200 m, chegou ao destino" mistura futuro com
 * passado e soa como erro de tradução. De longe se anuncia o que vai acontecer; em cima do ponto, o que
 * aconteceu.
 */
function acao(m: Manobra, locale: Locale, agora: boolean): string {
  const v = VERBO[locale]
  const lado = LADO[locale][m.modifier] ?? ''
  const rua = m.street ? ` ${v.on} ${m.street}` : ''

  if (m.type === 'arrive') {
    if (agora) return locale === 'pt-BR' ? 'Chegou ao destino' : 'Llegaste al destino'
    return locale === 'pt-BR' ? 'você chega ao destino' : 'llegás al destino'
  }
  if (m.type === 'roundabout' || m.type === 'rotary') return `${v.roundabout} ${lado}${rua}`.replace(/\s+/g, ' ').trim()
  if (m.type === 'fork') return `${v.fork} ${lado}${rua}`.replace(/\s+/g, ' ').trim()
  if (m.type === 'merge') return `${v.merge}${rua}`.trim()
  if (m.type === 'continue' || m.type === 'new name' || m.modifier === 'straight') return `${v.continue} ${lado}${rua}`.replace(/\s+/g, ' ').trim()
  return `${v.turn} ${lado}${rua}`.replace(/\s+/g, ' ').trim()
}

export type Instrucao = {
  /** O texto inteiro, pronto para a tela. */
  texto: string
  /** Metros até a curva. Para a barra que encolhe. */
  metros: number
  /** Está em cima da esquina: a tela destaca. */
  agora: boolean
  manobra: Manobra
}

/**
 * A PRÓXIMA CURVA. `metersAlong` é onde o motoboy está sobre a rota (a projeção — aqui ela serve, porque a
 * pergunta é "quanto falta de asfalto até a esquina", não "onde ele está").
 */
export function proximaManobra(route: Route, metersAlong: number, locale: Locale): Instrucao | null {
  const proxima = route.manobras.find((m) => m.atMeters > metersAlong + 1)
  if (!proxima) return null
  const metros = Math.max(0, proxima.atMeters - metersAlong)
  const agora = metros <= AGORA_M
  const corpo = acao(proxima, locale, agora)
  const v = VERBO[locale]
  // Chegar não ganha "agora" no fim: "chegou ao destino agora" é redundante, e a frase já é curta.
  const colar = proxima.type === 'arrive' ? corpo : `${corpo} ${v.now}`
  return {
    texto: agora ? colar : `${v.in} ${distanciaFalada(metros, locale)}, ${corpo.charAt(0).toLowerCase()}${corpo.slice(1)}`,
    metros: Math.round(metros),
    agora,
    manobra: proxima,
  }
}

/** A curva DEPOIS da próxima. O Waze mostra as duas, e é isso que evita a troca de faixa de última hora. */
export function manobraSeguinte(route: Route, metersAlong: number, locale: Locale): string | null {
  const i = route.manobras.findIndex((m) => m.atMeters > metersAlong + 1)
  const seguinte = i >= 0 ? route.manobras[i + 1] : undefined
  return seguinte ? acao(seguinte, locale, false) : null
}
