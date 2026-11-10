// Linhas do PostgREST -> formas do catálogo. Puro (sem rede, sem server-only): testável em Node.
// O PostgREST devolve `numeric` como número, mas aqui tudo passa por Number() e é verificado: preço que não é um
// número finito derruba o ITEM, não a página, e nunca vira "NaN" na tela.
import { effectiveMin } from './options'
import type { CatalogItem, OptionGroupData, PublicMerchant } from './types'

export type OptionRow = { id: string; group_id: string; name: string; price_delta_brl: number | string; is_available: boolean }
export type GroupRow = {
  id: string
  name: string
  min_select: number
  max_select: number
  is_required: boolean
  item_options: OptionRow[] | null
}
export type ItemRow = {
  id: string
  merchant_id: string
  category_id: string | null
  name: string
  description: string | null
  price_brl: number | string
  photo_url: string | null
  is_available: boolean
  sort_order: number
  item_option_groups: GroupRow[] | null
}
export type CategoryRow = { id: string; name: string; sort_order: number }

export type MenuSection = { id: string | null; name: string | null; items: CatalogItem[] }

const finite = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : null
}

function toGroup(g: GroupRow): OptionGroupData {
  const options: OptionGroupData['options'] = []
  for (const o of g.item_options ?? []) {
    const delta = finite(o.price_delta_brl)
    // Uma opção sem delta legível some, em vez de aparecer de graça: o servidor recusaria o preço de qualquer forma.
    if (delta === null) continue
    options.push({ id: o.id, groupId: g.id, name: o.name, priceDeltaBrl: delta, isAvailable: o.is_available })
  }
  return { id: g.id, name: g.name, minSelect: g.min_select, maxSelect: g.max_select, isRequired: g.is_required, options }
}

export function toItem(row: ItemRow): CatalogItem | null {
  const price = finite(row.price_brl)
  if (price === null || price < 0) return null
  const groups = (row.item_option_groups ?? []).map(toGroup)
  // Um grupo que exige mais opções do que as disponíveis nunca fecha o pedido: melhor "indisponível" que um botão
  // que a tela habilita e o servidor recusa.
  const satisfiable = groups.every((g) => g.options.filter((o) => o.isAvailable).length >= effectiveMin(g))
  return {
    id: row.id,
    merchantId: row.merchant_id,
    name: row.name,
    description: row.description,
    priceBrl: price,
    photoUrl: row.photo_url,
    isAvailable: row.is_available && satisfiable,
    groups,
  }
}

/** Seções do cardápio na ordem das categorias; itens sem categoria (ou de categoria sumida) ficam numa seção final. */
export function buildMenu(categories: readonly CategoryRow[], items: readonly ItemRow[]): MenuSection[] {
  const byOrder = (a: { sort_order: number; name: string }, b: { sort_order: number; name: string }) =>
    a.sort_order - b.sort_order || a.name.localeCompare(b.name)
  const mapped = [...items].sort(byOrder).flatMap((row) => {
    const item = toItem(row)
    return item ? [{ categoryId: row.category_id, item }] : []
  })

  const known = new Set(categories.map((c) => c.id))
  const sections: MenuSection[] = [...categories]
    .sort(byOrder)
    .map((c) => ({ id: c.id, name: c.name, items: mapped.filter((m) => m.categoryId === c.id).map((m) => m.item) }))
    .filter((s) => s.items.length > 0)
  const loose = mapped.filter((m) => m.categoryId === null || !known.has(m.categoryId)).map((m) => m.item)
  if (loose.length > 0) sections.push({ id: null, name: null, items: loose })
  return sections
}

export const MERCHANT_COLUMNS =
  'id,name,kind,city,country,address_text,prep_time_min,is_open_manual,accepts_cross_border,logo_url,cover_url' as const

export type MerchantRow = PublicMerchant & { is_open_manual: boolean }
