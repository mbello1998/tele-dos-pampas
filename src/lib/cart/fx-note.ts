// Aviso de cotação defasada. Preço em pesos que veio de uma taxa antiga (ou da padrão) tem de dizer de onde veio:
// "cotação de DD/MM". Preço estranho com explicação é suportável; preço estranho sem explicação vira chamado.
import type { DisplayFx } from './types'

export type FxNote = NonNullable<DisplayFx['note']>

const DATE = /^(\d{4})-(\d{2})-(\d{2})/

/**
 * @param rate   o que getEffectiveRate devolveu
 * @param today  a data civil de hoje (YYYY-MM-DD) no fuso das cidades, a mesma que o getEffectiveRate usa
 *
 * getEffectiveRate marca isStale tanto quando usa a última cotação gravada (validForDate antiga) quanto quando
 * cai na taxa padrão (aí validForDate vem como HOJE, mas nenhum feed a cotou). Os dois casos são distintos para o
 * cliente: o primeiro tem data de verdade, o segundo é "aproximada" e não pode fingir ser de hoje.
 */
export function fxNoteFrom(rate: { isStale: boolean; validForDate: string }, today: string): FxNote | undefined {
  if (!rate.isStale) return undefined
  const m = DATE.exec(rate.validForDate)
  if (!m || rate.validForDate.slice(0, 10) >= today) return { kind: 'default' }
  return { kind: 'dated', date: `${m[3]}/${m[2]}` }
}
