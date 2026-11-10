// Regras dos grupos de opção. Espelham o quote_order (0021): o servidor é quem decide o preço, e recusa qualquer
// seleção fora destas regras; aplicá-las aqui evita o round-trip e mostra o motivo antes do pedido.
import type { CatalogItem, OptionGroupData } from './types'

export type SelectionIssue =
  | { kind: 'duplicate'; optionId: string }
  | { kind: 'unknown_option'; optionId: string }
  | { kind: 'unavailable_option'; optionId: string }
  | { kind: 'too_few'; groupId: string; min: number; count: number }
  | { kind: 'too_many'; groupId: string; max: number; count: number }

/** Mínimo efetivo de um grupo: obrigatório vale ao menos 1, igual ao quote_order. */
export const effectiveMin = (g: OptionGroupData): number => (g.isRequired ? Math.max(g.minSelect, 1) : g.minSelect)

/** Primeiro problema da seleção, ou null se ela é válida. */
export function selectionIssue(item: CatalogItem, optionIds: readonly string[]): SelectionIssue | null {
  const seen = new Set<string>()
  const owner = new Map<string, { group: OptionGroupData; available: boolean }>()
  for (const g of item.groups) for (const o of g.options) owner.set(o.id, { group: g, available: o.isAvailable })

  for (const id of optionIds) {
    if (seen.has(id)) return { kind: 'duplicate', optionId: id }
    seen.add(id)
    const o = owner.get(id)
    if (!o) return { kind: 'unknown_option', optionId: id }
    if (!o.available) return { kind: 'unavailable_option', optionId: id }
  }

  for (const g of item.groups) {
    const count = g.options.filter((o) => seen.has(o.id)).length
    const min = effectiveMin(g)
    if (count < min) return { kind: 'too_few', groupId: g.id, min, count }
    if (count > g.maxSelect) return { kind: 'too_many', groupId: g.id, max: g.maxSelect, count }
  }
  return null
}

/** Ids dos grupos que ainda não atingiram o mínimo. */
export function missingGroups(item: CatalogItem, optionIds: readonly string[]): string[] {
  const chosen = new Set(optionIds)
  return item.groups.filter((g) => g.options.filter((o) => chosen.has(o.id)).length < effectiveMin(g)).map((g) => g.id)
}

/**
 * Marca ou desmarca uma opção. Desmarcar sempre funciona. Marcar além de max_select é recusado (devolve a
 * seleção como estava), exceto em grupo de escolha única (max 1), onde a nova escolha troca a antiga.
 */
export function toggleOption(group: OptionGroupData, selected: readonly string[], optionId: string): string[] {
  const inGroup = new Set(group.options.map((o) => o.id))
  if (!inGroup.has(optionId)) return [...selected]
  if (selected.includes(optionId)) return selected.filter((id) => id !== optionId)

  const current = selected.filter((id) => inGroup.has(id))
  if (current.length >= group.maxSelect) {
    if (group.maxSelect === 1) return [...selected.filter((id) => !inGroup.has(id)), optionId]
    return [...selected]
  }
  return [...selected, optionId]
}
