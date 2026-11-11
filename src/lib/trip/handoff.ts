import type { AddressInput } from '@/actions/addresses'
import type { TripKind } from '@/lib/pricing/trip'

/**
 * A TRAVESSIA DO TRAJETO PELO LOGIN.
 *
 * O problema que isto resolve: a tela inicial deixa qualquer pessoa montar um trajeto SEM CONTA — rua, quadra,
 * referência, preço. Mas confirmar exige conta, e a tela de confirmação só trabalha com endereços JÁ SALVOS.
 * Quem acabou de se cadastrar não tem nenhum. Resultado: o trabalho da pessoa ia para o lixo no login e ela caía
 * numa tela com duas listas vazias, sem entender por quê.
 *
 * Então o trajeto atravessa: fica guardado aqui antes de sair para o login e é recolhido do outro lado, onde as
 * duas pontas viram endereços da conta dela — o que de quebra faz o endereço aparecer salvo da próxima vez.
 *
 * `sessionStorage`, não `localStorage`: isto vale para ESTA ida ao login, não para sempre. Fecha a aba, acabou.
 * E é lido uma vez só (`takeTrip` apaga ao ler), para um trajeto velho não reaparecer num pedido novo.
 */
const KEY = 'tdp.trajeto'

export type HandoffPlace = {
  label: string
  detail: string
  address: AddressInput | null
}

export type TripHandoff = {
  kind: TripKind
  from: HandoffPlace
  to: HandoffPlace
  /** Quando foi guardado. Trajeto velho não serve: preço muda, e a pessoa já não lembra o que pediu. */
  at: number
}

/** Meia hora. Depois disso é mais honesto pedir de novo do que confirmar um pedido que a pessoa esqueceu. */
const MAX_AGE_MS = 30 * 60_000

export function putTrip(trip: Omit<TripHandoff, 'at'>): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...trip, at: Date.now() }))
  } catch {
    // Aba anônima, armazenamento cheio ou bloqueado: sem travessia, a tela de confirmação pede os endereços.
    // Nada quebra, só fica menos cômodo.
  }
}

/** Lê e APAGA. Devolve null se não houver, se estiver velho ou se o conteúdo não servir. */
export function takeTrip(): TripHandoff | null {
  let raw: string | null = null
  try {
    raw = sessionStorage.getItem(KEY)
    sessionStorage.removeItem(KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const t = JSON.parse(raw) as Partial<TripHandoff>
    if (!t || typeof t.at !== 'number' || Date.now() - t.at > MAX_AGE_MS) return null
    if (!t.from || !t.to || !t.kind) return null
    return t as TripHandoff
  } catch {
    return null
  }
}
