// O que a tela faz com o resultado de adicionar ao carrinho. Fica fora do componente para ser testável sem DOM.
// A regra de ouro: trocar de loja NUNCA esvazia o carrinho na primeira tentativa. O store recusa, esta função
// devolve 'confirm_switch', e só uma segunda chamada com replaceCart: true (o botão de confirmação) troca.
import type { CartStore } from './store'
import type { CartMerchant, CatalogItem } from './types'

export type AddOutcome =
  | { kind: 'added' }
  | { kind: 'confirm_switch'; currentMerchantName: string }
  | { kind: 'error'; messageKey: string }

export function attemptAdd(
  store: CartStore,
  merchant: CartMerchant,
  item: CatalogItem,
  optionIds: readonly string[],
  replaceCart = false,
): AddOutcome {
  const r = store.addItem(merchant, item, optionIds, 1, { replaceCart })
  if (r.ok) return { kind: 'added' }
  if (r.reason === 'other_merchant') return { kind: 'confirm_switch', currentMerchantName: r.currentMerchantName }
  return { kind: 'error', messageKey: `cart.error.${r.reason}` }
}
