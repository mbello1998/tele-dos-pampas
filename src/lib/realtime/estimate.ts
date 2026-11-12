import { pointAt, projectOnto, remainingMeters, type Route } from '@/lib/geo/route'
import type { LatLng } from '@/lib/geo/types'

/**
 * ONDE O MOTOBOY ESTÁ E QUANTO FALTA — inclusive quando o celular dele some do ar.
 *
 * O problema real: em Quaraí e Artigas o sinal cai. Entre o Cerro e a ponte tem trecho sem nada. Se o
 * rastreio simplesmente congelar, quem está esperando acha que o motoboy parou, liga para reclamar, e o
 * motoboy está andando o tempo todo.
 *
 * Então, quando o sinal cai, o sistema CONTINUA ANDANDO O MARCADOR pela rota, na velocidade média que ele
 * vinha fazendo. Isso é estimativa, não medição, e a tela diz isso com todas as letras nos dois lados — quem
 * finge que sabe perde a confiança de quem usa.
 *
 * Três limites guardam a honestidade:
 *   1. a estimativa PARA depois de `MAX_DEDUZIDO_MS`. Dois minutos sem notícia é incerteza; cinco é ficção;
 *   2. a estimativa nunca passa de `PARAR_ANTES_M` do destino. Um marcador deduzido que "chega" faria a
 *      pessoa descer para a calçada à toa;
 *   3. a velocidade média sai só de deslocamento medido de verdade, nunca de deslocamento deduzido —
 *      senão o erro se multiplica sozinho.
 */

/** Acima disto o rastreio está no plano B e as duas telas avisam. Duas leituras perdidas, com folga. */
export const SEM_SINAL_MS = 25_000
/** Depois disto o marcador congela: a dedução virou chute. */
export const MAX_DEDUZIDO_MS = 120_000
/** A dedução nunca encosta no destino. */
export const PARAR_ANTES_M = 120
/** O que o motoboy publica de intervalo (POSITION_MIN_INTERVAL_MS). Serve para a conta do próximo sinal. */
export const INTERVALO_ESPERADO_MS = 10_000
/** Velocidade de partida enquanto não há duas leituras para medir: moto em cidade pequena. */
export const VELOCIDADE_INICIAL_MS = 22 / 3.6
/** Tetos de sanidade: nada de moto a 5 km/h por um semáforo nem a 90 km/h por um erro de GPS. */
const VEL_MIN_MS = 8 / 3.6
const VEL_MAX_MS = 60 / 3.6
/** Quantas leituras entram na média. Poucas demais oscila, muitas demais não acompanha a mudança. */
const JANELA = 5

export type Fix = LatLng & { atMs: number }

export type Sinal = 'ao_vivo' | 'estimado' | 'perdido'

export type Estimativa = {
  /**
   * ONDE DESENHAR O PONTEIRO.
   *
   * Com sinal, é a LEITURA CRUA: onde o motoboy está de verdade. Antes aqui vinha sempre a projeção na rota,
   * e isso era mentira confortável — o ponteiro aparecia na rua mais próxima mesmo quando ele estava num
   * atalho, num pátio ou parado num posto fora da linha. Quem acompanha quer saber onde ele está, não onde
   * ele deveria estar.
   *
   * Sem sinal, aí sim é a projeção avançada sobre a rota: não há leitura, e a rota é o único palpite
   * defensável. A tela diz que é estimativa, e a linha à frente vira tracejada.
   */
  posicao: LatLng
  /** O mesmo ponto grudado na rota. Serve ao desenho da linha e à conta do que falta, não ao ponteiro. */
  naRota: LatLng
  /** A que distância da rota o GPS caiu. Grande e ao vivo = ele pegou outro caminho. */
  foraDaRotaM: number
  /** `ao_vivo` = medido agora. `estimado` = deduzido pela média. `perdido` = parou de deduzir. */
  sinal: Sinal
  /** Metros que faltam PELA RUA. */
  faltamMetros: number
  /** Segundos que faltam. Baseado na velocidade medida, com o palpite do roteador como piso de sanidade. */
  faltamSegundos: number
  /** Velocidade média usada, em m/s. */
  velocidadeMs: number
  /** Há quanto tempo não chega uma leitura de verdade. */
  desdeUltimaMs: number
  /** Quanto falta para a próxima leitura esperada; 0 quando já passou da hora. */
  proximaEmMs: number
}

/** A média das últimas leituras, em m/s. Só com deslocamento medido, nunca deduzido. */
export function velocidadeMedia(fixes: readonly Fix[], route: Route): number {
  const ultimos = fixes.slice(-JANELA)
  if (ultimos.length < 2) return VELOCIDADE_INICIAL_MS
  let metros = 0
  for (let i = 1; i < ultimos.length; i++) {
    // Medido SOBRE A ROTA: em linha reta, duas leituras em lados opostos de um quarteirão dariam uma
    // velocidade menor do que a real, e o tempo de chegada sairia inflado.
    const a = projectOnto(route, ultimos[i - 1]).metersAlong
    const b = projectOnto(route, ultimos[i]).metersAlong
    metros += Math.abs(b - a)
  }
  const segundos = (ultimos[ultimos.length - 1].atMs - ultimos[0].atMs) / 1000
  if (segundos <= 0) return VELOCIDADE_INICIAL_MS
  return Math.min(VEL_MAX_MS, Math.max(VEL_MIN_MS, metros / segundos))
}

/**
 * O estado do rastreio agora. Função pura: recebe as leituras, a rota e o relógio, e devolve o que as duas
 * telas precisam desenhar. Sem rede, sem estado escondido — o mesmo cálculo roda no cliente e no motoboy, e
 * os dois veem a mesma coisa, que é o que evita a discussão de "mas aqui aparece outra coisa".
 */
export function estimar(fixes: readonly Fix[], route: Route, agoraMs: number): Estimativa | null {
  if (fixes.length === 0) return null
  const ultimo = fixes[fixes.length - 1]
  const desdeUltimaMs = Math.max(0, agoraMs - ultimo.atMs)
  const velocidadeMs = velocidadeMedia(fixes, route)

  const medido = projectOnto(route, ultimo)
  let metersAlong = medido.metersAlong
  let sinal: Sinal = 'ao_vivo'

  if (desdeUltimaMs > SEM_SINAL_MS) {
    const deduzivelMs = Math.min(desdeUltimaMs, MAX_DEDUZIDO_MS)
    const avanco = (deduzivelMs / 1000) * velocidadeMs
    const teto = Math.max(metersAlong, route.meters - PARAR_ANTES_M)
    metersAlong = Math.min(metersAlong + avanco, teto)
    sinal = desdeUltimaMs > MAX_DEDUZIDO_MS ? 'perdido' : 'estimado'
  }

  const faltamMetros = remainingMeters(route, metersAlong)
  // O palpite do roteador entra como piso: se a média medida estiver otimista demais (motoboy acabou de sair
  // de uma reta e vai entrar no centro), o tempo não despenca para um número que não se cumpre.
  const porMedicao = faltamMetros / velocidadeMs
  const porRoteador = route.meters > 0 ? route.seconds * (faltamMetros / route.meters) : 0
  const faltamSegundos = Math.round(Math.max(porMedicao, porRoteador * 0.8))

  const naRota = pointAt(route, metersAlong)
  return {
    // Ao vivo: a leitura crua. Sem sinal: o ponto deduzido sobre a rota.
    posicao: sinal === 'ao_vivo' ? { lat: ultimo.lat, lng: ultimo.lng } : naRota,
    naRota,
    foraDaRotaM: Math.round(medido.offMeters),
    sinal,
    faltamMetros: Math.round(faltamMetros),
    faltamSegundos,
    velocidadeMs,
    desdeUltimaMs,
    proximaEmMs: Math.max(0, INTERVALO_ESPERADO_MS - desdeUltimaMs),
  }
}

/** "3 min", "agora". Arredonda para cima: prometer menos e cumprir é melhor que o contrário. */
export function textoChegada(segundos: number, locale: 'pt-BR' | 'es-UY'): string {
  const min = Math.ceil(segundos / 60)
  if (min <= 1) return locale === 'pt-BR' ? 'chega agora' : 'llega ahora'
  return locale === 'pt-BR' ? `${min} min` : `${min} min`
}
