// Carrinho do cliente: estado local, persistido em sessionStorage.
//
// O QUE ESTE CARRINHO NÃO É: a fonte do preço. `subtotalBrl` é uma estimativa visual dos itens, calculada em
// centavos inteiros. O valor que se paga vem do servidor (quote_order, e de novo no create_order, que recusa
// divergência acima de um centavo). O carrinho só guarda a INTENÇÃO: que item, quantas unidades, quais opções.
//
// Um merchant por carrinho. Adicionar item de outra loja é RECUSADO (reason 'other_merchant'); a tela pergunta
// ao cliente e só então chama de novo com { replaceCart: true }, que esvazia o carrinho antigo.
import { useSyncExternalStore } from 'react'
import { selectionIssue, type SelectionIssue } from './options'
import type { CartMerchant, CatalogItem } from './types'

export const MAX_QTY = 99 // a faixa que o quote_order aceita
const STORAGE_KEY = 'tdp.cart.v1'

export type CartLine = {
  lineId: string
  /** Snapshot do item como a tela o viu, com os grupos: é o que permite revalidar setOptions sem ir ao banco. */
  item: CatalogItem
  optionIds: string[]
  qty: number
}

export type CartState = {
  merchantId: string | null
  merchantName: string | null
  lines: CartLine[]
}

export type CartResult =
  | { ok: true }
  | { ok: false; reason: 'merchant_closed' | 'item_unavailable' | 'item_wrong_merchant' | 'invalid_qty' | 'line_not_found' }
  | { ok: false; reason: 'invalid_selection'; issue: SelectionIssue }
  | { ok: false; reason: 'other_merchant'; currentMerchantId: string; currentMerchantName: string }

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const EMPTY: CartState = Object.freeze({ merchantId: null, merchantName: null, lines: [] }) as CartState

/** Identidade de uma linha: o mesmo item com o mesmo conjunto de opções (em qualquer ordem) é a mesma linha. */
export const selectionKey = (itemId: string, optionIds: readonly string[]): string =>
  `${itemId}|${[...optionIds].sort().join(',')}`

const toCents = (brl: number): number => Math.round(brl * 100)

/** Preço de UMA unidade da linha em centavos: preço base mais o delta de cada opção escolhida. */
function unitCents(line: Pick<CartLine, 'item' | 'optionIds'>): number {
  const chosen = new Set(line.optionIds)
  let cents = toCents(line.item.priceBrl)
  for (const g of line.item.groups) for (const o of g.options) if (chosen.has(o.id)) cents += toCents(o.priceDeltaBrl)
  return cents
}

/** Estimativa visual do subtotal de itens em BRL. Não é o preço cobrado. */
export function subtotalBrlOf(state: CartState): number {
  let cents = 0
  for (const l of state.lines) cents += unitCents(l) * l.qty
  return cents / 100
}

/** Total de uma linha (unidade com opções x quantidade), estimativa visual. */
export const lineTotalBrl = (line: CartLine): number => (unitCents(line) * line.qty) / 100

const validQty = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= MAX_QTY

let lineSeq = 0
const newLineId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `l${Date.now().toString(36)}${lineSeq++}`

// --- restauração: o storage é entrada não confiável (outra aba, versão antiga, mão no DevTools) -----------------

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// O item guardado entra na tela e no subtotal: qualquer campo de dinheiro ou de regra que não seja o que o tipo
// promete (um NaN viraria subtotal NaN, e formatMoney lança com valor não finito) derruba a LINHA, nunca a página.
function validItem(item: CatalogItem): boolean {
  if (typeof item.id !== 'string' || typeof item.name !== 'string' || !isFiniteNumber(item.priceBrl) || item.priceBrl < 0) return false
  return item.groups.every(
    (g) =>
      g && typeof g.id === 'string' && typeof g.name === 'string' && Number.isInteger(g.minSelect) && Number.isInteger(g.maxSelect) &&
      Array.isArray(g.options) &&
      g.options.every((o) => o && typeof o.id === 'string' && typeof o.name === 'string' && isFiniteNumber(o.priceDeltaBrl)),
  )
}

function restore(raw: string | null): CartState {
  if (!raw) return EMPTY
  try {
    const data: unknown = JSON.parse(raw)
    if (!data || typeof data !== 'object') return EMPTY
    const d = data as Partial<CartState>
    if (typeof d.merchantId !== 'string' || typeof d.merchantName !== 'string' || !Array.isArray(d.lines)) return EMPTY
    const lines: CartLine[] = []
    for (const l of d.lines as Partial<CartLine>[]) {
      if (!l || typeof l.lineId !== 'string' || !l.item || !Array.isArray(l.optionIds) || !Array.isArray(l.item.groups)) continue
      if (typeof l.qty !== 'number' || !validQty(l.qty)) continue
      if (!validItem(l.item)) continue
      if (l.item.merchantId !== d.merchantId) continue
      if (selectionIssue(l.item, l.optionIds)) continue
      lines.push({ lineId: l.lineId, item: l.item, optionIds: l.optionIds.map(String), qty: l.qty })
    }
    return lines.length ? { merchantId: d.merchantId, merchantName: d.merchantName, lines } : EMPTY
  } catch {
    return EMPTY
  }
}

export function createCartStore(storage?: StorageLike) {
  const read = (): string | null => {
    try {
      return storage?.getItem(STORAGE_KEY) ?? null
    } catch {
      return null
    }
  }
  let state: CartState = restore(read())
  const listeners = new Set<() => void>()

  const commit = (next: CartState) => {
    state = next.lines.length ? next : EMPTY
    try {
      if (state.lines.length) storage?.setItem(STORAGE_KEY, JSON.stringify(state))
      else storage?.removeItem(STORAGE_KEY)
    } catch {
      // modo privado ou cota cheia: o carrinho segue valendo em memória
    }
    listeners.forEach((fn) => fn())
  }

  const sameSelection = (a: Pick<CartLine, 'item' | 'optionIds'>, b: Pick<CartLine, 'item' | 'optionIds'>) =>
    selectionKey(a.item.id, a.optionIds) === selectionKey(b.item.id, b.optionIds)

  return {
    getState: (): CartState => state,
    subscribe(fn: () => void): () => void {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
    subtotalBrl: (): number => subtotalBrlOf(state),

    addItem(
      merchant: CartMerchant,
      item: CatalogItem,
      optionIds: readonly string[],
      qty = 1,
      opts: { replaceCart?: boolean } = {},
    ): CartResult {
      if (!merchant.isOpen) return { ok: false, reason: 'merchant_closed' }
      if (item.merchantId !== merchant.id) return { ok: false, reason: 'item_wrong_merchant' }
      if (!item.isAvailable) return { ok: false, reason: 'item_unavailable' }
      if (!validQty(qty)) return { ok: false, reason: 'invalid_qty' }
      const issue = selectionIssue(item, optionIds)
      if (issue) return { ok: false, reason: 'invalid_selection', issue }

      const other = state.merchantId !== null && state.merchantId !== merchant.id
      if (other && !opts.replaceCart) {
        return { ok: false, reason: 'other_merchant', currentMerchantId: state.merchantId!, currentMerchantName: state.merchantName ?? '' }
      }
      // Só chega aqui com loja diferente se o cliente confirmou a troca: o carrinho antigo sai por inteiro.
      const base = other ? EMPTY : state

      const incoming = { item, optionIds: [...optionIds] }
      const existing = base.lines.find((l) => sameSelection(l, incoming))
      if (existing) {
        const total = existing.qty + qty
        if (!validQty(total)) return { ok: false, reason: 'invalid_qty' }
        commit({ ...base, lines: base.lines.map((l) => (l === existing ? { ...l, qty: total } : l)) })
      } else {
        commit({
          merchantId: merchant.id,
          merchantName: merchant.name,
          lines: [...base.lines, { lineId: newLineId(), ...incoming, qty }],
        })
      }
      return { ok: true }
    },

    removeItem(lineId: string): void {
      if (!state.lines.some((l) => l.lineId === lineId)) return
      commit({ ...state, lines: state.lines.filter((l) => l.lineId !== lineId) })
    },

    setQty(lineId: string, qty: number): CartResult {
      const line = state.lines.find((l) => l.lineId === lineId)
      if (!line) return { ok: false, reason: 'line_not_found' }
      if (qty === 0) {
        commit({ ...state, lines: state.lines.filter((l) => l !== line) })
        return { ok: true }
      }
      if (!validQty(qty)) return { ok: false, reason: 'invalid_qty' }
      commit({ ...state, lines: state.lines.map((l) => (l === line ? { ...l, qty } : l)) })
      return { ok: true }
    },

    /** Troca as opções de uma linha, revalidando tudo. Se ela passa a ser igual a outra linha, as duas se fundem. */
    setOptions(lineId: string, optionIds: readonly string[]): CartResult {
      const line = state.lines.find((l) => l.lineId === lineId)
      if (!line) return { ok: false, reason: 'line_not_found' }
      const issue = selectionIssue(line.item, optionIds)
      if (issue) return { ok: false, reason: 'invalid_selection', issue }

      const changed: CartLine = { ...line, optionIds: [...optionIds] }
      const twin = state.lines.find((l) => l !== line && sameSelection(l, changed))
      if (twin) {
        const total = twin.qty + changed.qty
        if (!validQty(total)) return { ok: false, reason: 'invalid_qty' }
        commit({ ...state, lines: state.lines.filter((l) => l !== line).map((l) => (l === twin ? { ...l, qty: total } : l)) })
      } else {
        commit({ ...state, lines: state.lines.map((l) => (l === line ? changed : l)) })
      }
      return { ok: true }
    },

    clear(): void {
      if (state.lines.length || state.merchantId) commit(EMPTY)
    },
  }
}

export type CartStore = ReturnType<typeof createCartStore>

function browserStorage(): StorageLike | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined // acessar sessionStorage pode lançar com os dados do site bloqueados
  }
}

/** O carrinho da aba. No servidor não há storage: nasce vazio e nunca é lido para renderizar. */
export const cartStore: CartStore = createCartStore(browserStorage())

/** Estado do carrinho em componente. O snapshot do servidor é sempre vazio, para a hidratação não divergir. */
export function useCart(store: CartStore = cartStore): CartState {
  return useSyncExternalStore(store.subscribe, store.getState, () => EMPTY)
}
