import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { formatMoney } from '@/lib/money/format'
import { createCartStore, MAX_QTY, selectionKey, subtotalBrlOf, type CartState } from '@/lib/cart/store'
import { missingGroups, selectionIssue, toggleOption } from '@/lib/cart/options'
import { buildMenu, toItem, type ItemRow } from '@/lib/cart/catalog-map'
import { attemptAdd } from '@/lib/cart/add-flow'
import { isMerchantOpen as isMerchantOpenReal, type MerchantHoursRow, type MerchantOpenInput } from '@/lib/cart/open'
import { loadServiceWindows } from '@/lib/cart/service-window'
import { fxNoteFrom } from '@/lib/cart/fx-note'
import { FxNote } from '@/components/catalog/FxNote'
import { formatDisplayMoney, formatMoneyCeil, toDisplayAmount } from '@/lib/cart/money'
import { catalogT, COPY } from '@/lib/cart/copy'
import type { CatalogItem, OptionGroupData } from '@/lib/cart/types'
import { PriceSummary, type PriceSummaryQuote } from '@/components/order/PriceSummary'
import { Cart } from '@/components/order/Cart'
import { ItemCard } from '@/components/catalog/ItemCard'
import { MerchantCard } from '@/components/catalog/MerchantCard'
import { OptionGroup } from '@/components/catalog/OptionGroup'

// ---------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------
const M1 = { id: 'm1', name: 'Trailer do Zé', isOpen: true }
const M2 = { id: 'm2', name: 'La Frontera', isOpen: true }

const group = (over: Partial<OptionGroupData> & { id: string }): OptionGroupData => ({
  name: over.id,
  minSelect: 0,
  maxSelect: 1,
  isRequired: false,
  options: [],
  ...over,
})
const opt = (id: string, groupId: string, deltaBrl: number, isAvailable = true) => ({
  id,
  groupId,
  name: id,
  priceDeltaBrl: deltaBrl,
  isAvailable,
})

// X-Salada: R$ 19,90. Tamanho (obrigatório, 1): P +0, G +4,10. Extras (0..2): bacon +2,50 / ovo +1,10 / queijo +3,00.
const lanche = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  id: 'i1',
  merchantId: 'm1',
  name: 'X-Salada',
  description: 'Pão, carne, salada',
  priceBrl: 19.9,
  photoUrl: null,
  isAvailable: true,
  groups: [
    group({
      id: 'g-tam',
      name: 'Tamanho',
      isRequired: true,
      minSelect: 1,
      maxSelect: 1,
      options: [opt('o-p', 'g-tam', 0), opt('o-g', 'g-tam', 4.1)],
    }),
    group({
      id: 'g-ext',
      name: 'Extras',
      maxSelect: 2,
      options: [opt('o-bacon', 'g-ext', 2.5), opt('o-ovo', 'g-ext', 1.1), opt('o-queijo', 'g-ext', 3)],
    }),
  ],
  ...over,
})
const agua = (): CatalogItem => ({
  id: 'i2',
  merchantId: 'm1',
  name: 'Água',
  description: null,
  priceBrl: 5,
  photoUrl: null,
  isAvailable: true,
  groups: [],
})
const itemDeOutraLoja = (): CatalogItem => ({ ...agua(), id: 'i9', merchantId: 'm2', name: 'Mate' })

const memoryStorage = () => {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
}

const novoStore = () => createCartStore()

// ---------------------------------------------------------------------------------------------
// carrinho
// ---------------------------------------------------------------------------------------------
describe('subtotal do carrinho', () => {
  test('subtotal soma preço base mais price_delta das opções escolhidas', () => {
    const s = novoStore()
    // 19,90 + 4,10 (G) + 2,50 (bacon) + 1,10 (ovo) = 27,60
    const r = s.addItem(M1, lanche(), ['o-g', 'o-bacon', 'o-ovo'])
    expect(r.ok).toBe(true)
    expect(s.subtotalBrl()).toBe(27.6)
  })

  test('multiplica pela quantidade e soma as linhas', () => {
    const s = novoStore()
    s.addItem(M1, lanche(), ['o-p', 'o-queijo'], 3) // (19,90 + 3,00) x 3 = 68,70
    s.addItem(M1, agua(), [], 2) // 10,00
    expect(s.subtotalBrl()).toBe(78.7)
  })

  test('soma em centavos: 0,1 + 0,2 não vira 0,30000000000000004 e centavos não somem', () => {
    const item = lanche({
      priceBrl: 0.1,
      groups: [group({ id: 'g', maxSelect: 1, options: [opt('a', 'g', 0.2)] })],
    })
    const s = novoStore()
    s.addItem(M1, item, ['a'], 3)
    expect(s.subtotalBrl()).toBe(0.9)
    // 19,99 x 7 = 139,93 (em ponto flutuante cru: 139.92999999999998)
    const t = novoStore()
    t.addItem(M1, { ...agua(), priceBrl: 19.99 }, [], 7)
    expect(t.subtotalBrl()).toBe(139.93)
  })

  test('carrinho vazio soma zero', () => {
    expect(novoStore().subtotalBrl()).toBe(0)
  })

  test('subtotalBrlOf calcula a partir do estado, sem depender do store', () => {
    const s = novoStore()
    s.addItem(M1, agua(), [], 2)
    expect(subtotalBrlOf(s.getState())).toBe(10)
  })

  test('opção com price_delta negativo reduz o preço da linha (o schema permite)', () => {
    const item = lanche({
      groups: [group({ id: 'g', options: [opt('desc', 'g', -2)] })],
    })
    const s = novoStore()
    s.addItem(M1, item, ['desc'])
    expect(s.subtotalBrl()).toBe(17.9)
  })
})

describe('regras de seleção de opções', () => {
  test('grupo de opção obrigatório impede adicionar ao carrinho', () => {
    const s = novoStore()
    const r = s.addItem(M1, lanche(), []) // Tamanho é obrigatório
    expect(r).toMatchObject({ ok: false, reason: 'invalid_selection' })
    expect(s.getState().lines).toEqual([])
    expect(s.subtotalBrl()).toBe(0)
  })

  test('is_required com min_select 0 ainda exige ao menos uma opção (mesma regra do quote_order)', () => {
    const item = lanche({
      groups: [group({ id: 'g', isRequired: true, minSelect: 0, maxSelect: 2, options: [opt('a', 'g', 0), opt('b', 'g', 0)] })],
    })
    expect(missingGroups(item, [])).toEqual(['g'])
    expect(missingGroups(item, ['a'])).toEqual([])
    expect(novoStore().addItem(M1, item, [])).toMatchObject({ ok: false })
  })

  test('min_select maior que 1 exige essa quantidade mesmo sem is_required', () => {
    const item = lanche({
      groups: [group({ id: 'g', minSelect: 2, maxSelect: 3, options: [opt('a', 'g', 0), opt('b', 'g', 0), opt('c', 'g', 0)] })],
    })
    expect(missingGroups(item, ['a'])).toEqual(['g'])
    expect(missingGroups(item, ['a', 'b'])).toEqual([])
  })

  test('max_select bloqueia a seleção excedente (toggle não passa do máximo)', () => {
    const g = lanche().groups[1] // Extras, máximo 2
    let sel = toggleOption(g, [], 'o-bacon')
    sel = toggleOption(g, sel, 'o-ovo')
    expect(sel).toEqual(['o-bacon', 'o-ovo'])
    expect(toggleOption(g, sel, 'o-queijo')).toEqual(['o-bacon', 'o-ovo']) // o terceiro é recusado
    expect(toggleOption(g, sel, 'o-ovo')).toEqual(['o-bacon']) // desmarcar sempre funciona
  })

  test('max_select 1 troca a escolha em vez de travar (comportamento de rádio)', () => {
    const g = lanche().groups[0]
    expect(toggleOption(g, ['o-p'], 'o-g')).toEqual(['o-g'])
  })

  test('o store também recusa seleção acima de max_select, mesmo que a tela deixasse passar', () => {
    const s = novoStore()
    const r = s.addItem(M1, lanche(), ['o-p', 'o-bacon', 'o-ovo', 'o-queijo'])
    expect(r).toMatchObject({ ok: false, reason: 'invalid_selection' })
    expect(s.getState().lines).toEqual([])
  })

  test('opção repetida, desconhecida ou indisponível é recusada', () => {
    const item = lanche()
    item.groups[1].options.push(opt('o-esgotado', 'g-ext', 1, false))
    expect(selectionIssue(item, ['o-p', 'o-bacon', 'o-bacon'])).toMatchObject({ kind: 'duplicate' })
    expect(selectionIssue(item, ['o-p', 'o-fantasma'])).toMatchObject({ kind: 'unknown_option' })
    expect(selectionIssue(item, ['o-p', 'o-esgotado'])).toMatchObject({ kind: 'unavailable_option' })
    expect(selectionIssue(item, ['o-p', 'o-bacon'])).toBeNull()
  })

  test('item indisponível não entra no carrinho', () => {
    const r = novoStore().addItem(M1, agua(), [], 1)
    expect(r.ok).toBe(true)
    expect(novoStore().addItem(M1, { ...agua(), isAvailable: false }, [])).toMatchObject({
      ok: false,
      reason: 'item_unavailable',
    })
  })

  test('quantidade fora de 1..99 é recusada (a faixa do quote_order)', () => {
    const s = novoStore()
    expect(s.addItem(M1, agua(), [], 0)).toMatchObject({ ok: false, reason: 'invalid_qty' })
    expect(s.addItem(M1, agua(), [], 1.5)).toMatchObject({ ok: false, reason: 'invalid_qty' })
    expect(s.addItem(M1, agua(), [], MAX_QTY + 1)).toMatchObject({ ok: false, reason: 'invalid_qty' })
    expect(s.addItem(M1, agua(), [], MAX_QTY).ok).toBe(true)
  })
})

describe('um merchant por carrinho', () => {
  test('carrinho só aceita itens de um merchant por vez', () => {
    const s = novoStore()
    s.addItem(M1, agua(), [])
    const r = s.addItem(M2, itemDeOutraLoja(), [])
    expect(r).toMatchObject({ ok: false, reason: 'other_merchant', currentMerchantName: 'Trailer do Zé' })
    // nada mudou: o carrinho segue com a loja 1
    expect(s.getState().merchantId).toBe('m1')
    expect(s.getState().lines).toHaveLength(1)
  })

  test('só troca de loja com confirmação explícita: replaceCart limpa o carrinho antigo', () => {
    const s = novoStore()
    s.addItem(M1, agua(), [], 2)
    const r = s.addItem(M2, itemDeOutraLoja(), [], 1, { replaceCart: true })
    expect(r.ok).toBe(true)
    expect(s.getState().merchantId).toBe('m2')
    expect(s.getState().lines.map((l) => l.item.id)).toEqual(['i9'])
    expect(s.subtotalBrl()).toBe(5)
  })

  test('replaceCart não apaga o carrinho antigo quando o novo item é inválido', () => {
    const s = novoStore()
    s.addItem(M1, agua(), [], 2)
    const r = s.addItem(M2, { ...itemDeOutraLoja(), isAvailable: false }, [], 1, { replaceCart: true })
    expect(r.ok).toBe(false)
    expect(s.getState().merchantId).toBe('m1')
    expect(s.getState().lines).toHaveLength(1)
  })

  test('o item precisa pertencer ao merchant informado', () => {
    const s = novoStore()
    expect(s.addItem(M1, itemDeOutraLoja(), [])).toMatchObject({ ok: false, reason: 'item_wrong_merchant' })
  })

  test('esvaziar o carrinho libera a escolha de outra loja', () => {
    const s = novoStore()
    const r1 = s.addItem(M1, agua(), [])
    if (!r1.ok) throw new Error('setup')
    s.removeItem(s.getState().lines[0].lineId)
    expect(s.getState().merchantId).toBeNull()
    expect(s.addItem(M2, itemDeOutraLoja(), []).ok).toBe(true)
  })
})

describe('fluxo de adicionar (o que a tela faz com o resultado)', () => {
  test('primeira tentativa com loja diferente pede confirmação e NÃO mexe no carrinho', () => {
    const s = novoStore()
    s.addItem(M1, agua(), [], 2)
    const antes = s.getState()
    expect(attemptAdd(s, M2, itemDeOutraLoja(), [])).toEqual({ kind: 'confirm_switch', currentMerchantName: 'Trailer do Zé' })
    expect(s.getState()).toBe(antes)
  })

  test('confirmada, a troca esvazia o carrinho antigo e adiciona', () => {
    const s = novoStore()
    s.addItem(M1, agua(), [], 2)
    expect(attemptAdd(s, M2, itemDeOutraLoja(), [], true)).toEqual({ kind: 'added' })
    expect(s.getState().merchantId).toBe('m2')
    expect(s.getState().lines).toHaveLength(1)
  })

  test('erro vira uma chave de mensagem existente nos dois idiomas', () => {
    const s = novoStore()
    for (const [outcome, key] of [
      [attemptAdd(s, { ...M1, isOpen: false }, agua(), []), 'cart.error.merchant_closed'],
      [attemptAdd(s, M1, { ...agua(), isAvailable: false }, []), 'cart.error.item_unavailable'],
      [attemptAdd(s, M1, lanche(), []), 'cart.error.invalid_selection'],
    ] as const) {
      expect(outcome).toEqual({ kind: 'error', messageKey: key })
      expect(COPY['pt-BR'][key]).toBeTruthy()
      expect(COPY['es-UY'][key]).toBeTruthy()
    }
  })
})

describe('loja fechada no carrinho', () => {
  test('loja fechada não deixa adicionar', () => {
    const s = novoStore()
    const r = s.addItem({ ...M1, isOpen: false }, agua(), [])
    expect(r).toMatchObject({ ok: false, reason: 'merchant_closed' })
    expect(s.getState().lines).toEqual([])
  })
})

describe('linhas, remoção e setOptions', () => {
  test('o mesmo item com as mesmas opções (em outra ordem) soma a quantidade em uma linha', () => {
    const s = novoStore()
    s.addItem(M1, lanche(), ['o-p', 'o-bacon', 'o-ovo'])
    s.addItem(M1, lanche(), ['o-ovo', 'o-p', 'o-bacon'], 2)
    expect(s.getState().lines).toHaveLength(1)
    expect(s.getState().lines[0].qty).toBe(3)
    expect(selectionKey('i1', ['b', 'a'])).toBe(selectionKey('i1', ['a', 'b']))
  })

  test('opções diferentes viram linhas diferentes', () => {
    const s = novoStore()
    s.addItem(M1, lanche(), ['o-p'])
    s.addItem(M1, lanche(), ['o-g'])
    expect(s.getState().lines).toHaveLength(2)
  })

  test('somar quantidade passando de 99 é recusado e não altera o carrinho', () => {
    const s = novoStore()
    s.addItem(M1, agua(), [], 98)
    expect(s.addItem(M1, agua(), [], 2)).toMatchObject({ ok: false, reason: 'invalid_qty' })
    expect(s.getState().lines[0].qty).toBe(98)
  })

  test('removeItem tira a linha e o subtotal acompanha', () => {
    const s = novoStore()
    s.addItem(M1, agua(), [], 2)
    s.addItem(M1, lanche(), ['o-p'])
    const [a, l] = s.getState().lines
    s.removeItem(a.lineId)
    expect(s.getState().lines.map((x) => x.lineId)).toEqual([l.lineId])
    expect(s.subtotalBrl()).toBe(19.9)
  })

  test('setOptions troca as opções e recalcula', () => {
    const s = novoStore()
    s.addItem(M1, lanche(), ['o-p'])
    const id = s.getState().lines[0].lineId
    const r = s.setOptions(id, ['o-g', 'o-queijo'])
    expect(r.ok).toBe(true)
    expect(s.subtotalBrl()).toBe(27) // 19,90 + 4,10 + 3,00
  })

  test('setOptions que viola uma regra é recusado e preserva a linha como estava', () => {
    const s = novoStore()
    s.addItem(M1, lanche(), ['o-p'])
    const id = s.getState().lines[0].lineId
    expect(s.setOptions(id, [])).toMatchObject({ ok: false, reason: 'invalid_selection' }) // tira o obrigatório
    expect(s.getState().lines[0].optionIds).toEqual(['o-p'])
    expect(s.subtotalBrl()).toBe(19.9)
  })

  test('setOptions que deixa duas linhas idênticas funde as duas', () => {
    const s = novoStore()
    s.addItem(M1, lanche(), ['o-p'], 1)
    s.addItem(M1, lanche(), ['o-g'], 2)
    const first = s.getState().lines[0].lineId
    s.setOptions(first, ['o-g'])
    expect(s.getState().lines).toHaveLength(1)
    expect(s.getState().lines[0].qty).toBe(3)
  })

  test('setQty muda a quantidade e zero remove a linha', () => {
    const s = novoStore()
    s.addItem(M1, agua(), [], 1)
    const id = s.getState().lines[0].lineId
    s.setQty(id, 4)
    expect(s.subtotalBrl()).toBe(20)
    s.setQty(id, 0)
    expect(s.getState().lines).toEqual([])
    expect(s.getState().merchantId).toBeNull()
  })

  test('setQty acima de 99 é recusado', () => {
    const s = novoStore()
    s.addItem(M1, agua(), [], 1)
    const id = s.getState().lines[0].lineId
    expect(s.setQty(id, 100)).toMatchObject({ ok: false, reason: 'invalid_qty' })
    expect(s.getState().lines[0].qty).toBe(1)
  })

  test('operação em linha que não existe falha sem lançar', () => {
    const s = novoStore()
    expect(s.setOptions('nada', [])).toMatchObject({ ok: false, reason: 'line_not_found' })
    expect(s.setQty('nada', 2)).toMatchObject({ ok: false, reason: 'line_not_found' })
    expect(() => s.removeItem('nada')).not.toThrow()
  })

  test('clear esvazia tudo', () => {
    const s = novoStore()
    s.addItem(M1, agua(), [])
    s.clear()
    expect(s.getState()).toEqual({ merchantId: null, merchantName: null, lines: [] })
  })
})

describe('observadores e persistência em sessionStorage', () => {
  test('notifica quem assina, e não notifica quando a operação é recusada', () => {
    const s = novoStore()
    let n = 0
    const off = s.subscribe(() => void n++)
    s.addItem(M1, agua(), [])
    expect(n).toBe(1)
    const antes = s.getState()
    s.addItem(M1, lanche(), []) // recusado
    expect(n).toBe(1)
    expect(s.getState()).toBe(antes) // mesma referência: useSyncExternalStore não re-renderiza à toa
    off()
    s.addItem(M1, agua(), [])
    expect(n).toBe(1)
  })

  test('o carrinho persiste no storage e um store novo o relê', () => {
    const storage = memoryStorage()
    const a = createCartStore(storage)
    a.addItem(M1, lanche(), ['o-g', 'o-bacon'], 2)
    const b = createCartStore(storage)
    expect(b.getState()).toEqual(a.getState())
    expect(b.subtotalBrl()).toBe((19.9 + 4.1 + 2.5) * 2)
  })

  test('esvaziar o carrinho limpa o storage', () => {
    const storage = memoryStorage()
    const a = createCartStore(storage)
    a.addItem(M1, agua(), [])
    a.clear()
    expect(createCartStore(storage).getState().lines).toEqual([])
  })

  test('conteúdo corrompido ou adulterado no storage é ignorado, não quebra', () => {
    for (const lixo of ['{', 'null', '[]', '{"merchantId":1}', '{"merchantId":"m1","merchantName":"x","lines":[{"qty":-3}]}']) {
      const storage = memoryStorage()
      storage.setItem('tdp.cart.v1', lixo)
      const s = createCartStore(storage)
      expect(s.getState().lines).toEqual([])
      expect(s.subtotalBrl()).toBe(0)
    }
  })

  test('linha restaurada que viola as regras da própria opção é descartada', () => {
    const storage = memoryStorage()
    const a = createCartStore(storage)
    a.addItem(M1, lanche(), ['o-p'])
    const adulterado = JSON.parse(storage.data.get('tdp.cart.v1')!) as CartState
    adulterado.lines[0].optionIds = [] // tira o grupo obrigatório
    storage.setItem('tdp.cart.v1', JSON.stringify(adulterado))
    expect(createCartStore(storage).getState().lines).toEqual([])
  })

  test('linha restaurada com quantidade fora de 1..99 ou fracionária é descartada', () => {
    for (const qty of [0, -3, 100, 1.5, 500]) {
      const storage = memoryStorage()
      createCartStore(storage).addItem(M1, agua(), [], 2)
      const adulterado = JSON.parse(storage.data.get('tdp.cart.v1')!) as CartState
      adulterado.lines[0].qty = qty
      storage.setItem('tdp.cart.v1', JSON.stringify(adulterado))
      expect(createCartStore(storage).getState().lines, `qty ${qty}`).toEqual([])
    }
  })

  test('linha restaurada cujo item é de outra loja que a do carrinho é descartada', () => {
    const storage = memoryStorage()
    createCartStore(storage).addItem(M1, agua(), [], 1)
    const adulterado = JSON.parse(storage.data.get('tdp.cart.v1')!) as CartState
    adulterado.lines[0].item.merchantId = 'm2'
    storage.setItem('tdp.cart.v1', JSON.stringify(adulterado))
    expect(createCartStore(storage).getState().lines).toEqual([])
  })

  test('storage que lança (modo privado, cota cheia) não derruba o carrinho', () => {
    const quebrado = {
      getItem: () => {
        throw new Error('negado')
      },
      setItem: () => {
        throw new Error('cota')
      },
      removeItem: () => {
        throw new Error('negado')
      },
    }
    const s = createCartStore(quebrado)
    expect(s.addItem(M1, agua(), []).ok).toBe(true)
    expect(s.subtotalBrl()).toBe(5)
  })
})

// ---------------------------------------------------------------------------------------------
// loja aberta
// ---------------------------------------------------------------------------------------------
// Nos testes de horário da loja o horário de serviço do município vale aberto, salvo pedido em contrário.
const isMerchantOpen = (m: MerchantOpenInput, h: readonly MerchantHoursRow[], now: Date, serviceOpen = true) =>
  isMerchantOpenReal(m, h, now, serviceOpen)

describe('loja aberta', () => {
  // terça 10/11/2026 12:00 em Quaraí e em Artigas (as duas em UTC-3), ou seja 15:00Z.
  const terca12h = new Date('2026-11-10T15:00:00Z')
  const faixa = (weekday: number, opens_at: string, closes_at: string): MerchantHoursRow => ({ weekday, opens_at, closes_at })
  const quarai = { status: 'approved', is_open_manual: true, city: 'quarai' }

  test('aberta: aprovada, manual ligado e dentro de uma faixa', () => {
    expect(isMerchantOpen(quarai, [faixa(2, '11:00:00', '15:00:00')], terca12h)).toBe(true)
  })

  test('loja fechada por horário aparece como fechada', () => {
    expect(isMerchantOpen(quarai, [faixa(2, '13:00:00', '15:00:00')], terca12h)).toBe(false)
    expect(isMerchantOpen(quarai, [faixa(2, '08:00:00', '11:59:59')], terca12h)).toBe(false)
  })

  test('is_open_manual false fecha a loja mesmo dentro do horário', () => {
    const h = [faixa(2, '11:00:00', '15:00:00')]
    expect(isMerchantOpen({ ...quarai, is_open_manual: false }, h, terca12h)).toBe(false)
  })

  test('status diferente de approved fecha a loja mesmo com manual ligado e dentro do horário', () => {
    const h = [faixa(2, '11:00:00', '15:00:00')]
    expect(isMerchantOpen({ ...quarai, status: 'suspended' }, h, terca12h)).toBe(false)
    expect(isMerchantOpen({ ...quarai, status: 'pending' }, h, terca12h)).toBe(false)
  })

  test('linha vinda da view merchants_public (sem coluna status) vale como aprovada', () => {
    const doView = { is_open_manual: true, city: 'quarai' }
    expect(isMerchantOpen(doView, [faixa(2, '11:00:00', '15:00:00')], terca12h)).toBe(true)
  })

  test('sem nenhuma faixa cadastrada a loja está fechada (silêncio não significa aberto)', () => {
    expect(isMerchantOpen(quarai, [], terca12h)).toBe(false)
  })

  test('faixa de outro dia da semana não vale', () => {
    expect(isMerchantOpen(quarai, [faixa(3, '11:00:00', '15:00:00')], terca12h)).toBe(false)
  })

  test('várias faixas no dia: almoço e noite, com intervalo fechado', () => {
    const h = [faixa(2, '11:00:00', '14:00:00'), faixa(2, '18:00:00', '23:00:00')]
    expect(isMerchantOpen(quarai, h, terca12h)).toBe(true)
    expect(isMerchantOpen(quarai, h, new Date('2026-11-10T17:00:00Z'))).toBe(false) // 14:00 local, fim exclusivo
    expect(isMerchantOpen(quarai, h, new Date('2026-11-10T19:30:00Z'))).toBe(false) // 16:30
    expect(isMerchantOpen(quarai, h, new Date('2026-11-10T22:00:00Z'))).toBe(true) // 19:00
  })

  test('usa o relógio da cidade da loja, não o do servidor (UTC)', () => {
    // 22:00Z é 19:00 em Quaraí. Lido em UTC (22:00) cairia fora da faixa 18-20.
    const h = [faixa(2, '18:00:00', '20:00:00')]
    expect(isMerchantOpen(quarai, h, new Date('2026-11-10T22:00:00Z'))).toBe(true)
    expect(isMerchantOpen({ ...quarai, city: 'artigas' }, h, new Date('2026-11-10T22:00:00Z'))).toBe(true)
    // 01:00Z do dia 11 ainda é 22:00 de terça lá: o dia da semana também é o local.
    expect(isMerchantOpen(quarai, [faixa(2, '21:00:00', '23:00:00')], new Date('2026-11-11T01:00:00Z'))).toBe(true)
  })

  test('faixa que atravessa a meia-noite vale nos dois lados', () => {
    const h = [faixa(5, '18:00:00', '02:00:00')] // sexta 18:00 até sábado 02:00
    expect(isMerchantOpen(quarai, h, new Date('2026-11-13T21:30:00Z'))).toBe(true) // sex 18:30
    expect(isMerchantOpen(quarai, h, new Date('2026-11-14T04:00:00Z'))).toBe(true) // sáb 01:00
    expect(isMerchantOpen(quarai, h, new Date('2026-11-14T05:00:00Z'))).toBe(false) // sáb 02:00, fim exclusivo
    expect(isMerchantOpen(quarai, h, new Date('2026-11-13T20:30:00Z'))).toBe(false) // sex 17:30
  })

  test('fecha às 00:00 significa até a meia-noite: 23:59 aberto, 00:00 seguinte fechado', () => {
    const h = [faixa(2, '06:00:00', '00:00:00')]
    expect(isMerchantOpen(quarai, h, new Date('2026-11-11T02:59:00Z'))).toBe(true) // ter 23:59
    expect(isMerchantOpen(quarai, h, new Date('2026-11-11T03:00:00Z'))).toBe(false) // qua 00:00
    expect(isMerchantOpen(quarai, h, new Date('2026-11-10T08:59:00Z'))).toBe(false) // ter 05:59
    expect(isMerchantOpen(quarai, h, new Date('2026-11-10T09:00:00Z'))).toBe(true) // ter 06:00, início inclusivo
  })

  test('faixa comum: o início é inclusivo e o fim exclusivo', () => {
    const h = [faixa(2, '11:00:00', '15:00:00')]
    expect(isMerchantOpen(quarai, h, new Date('2026-11-10T14:00:00Z'))).toBe(true) // 11:00 exato
    expect(isMerchantOpen(quarai, h, new Date('2026-11-10T13:59:59Z'))).toBe(false) // 10:59:59
    expect(isMerchantOpen(quarai, h, new Date('2026-11-10T17:59:59Z'))).toBe(true) // 14:59:59
    expect(isMerchantOpen(quarai, h, new Date('2026-11-10T18:00:00Z'))).toBe(false) // 15:00 exato
  })

  test('faixa que atravessa a meia-noite em OUTRO dia da semana não abre a loja hoje', () => {
    // terça 20:00 local; a faixa é de quarta 18:00 a quinta 02:00 e a de segunda 18:00 a terça 02:00 já acabou
    const h = [faixa(3, '18:00:00', '02:00:00'), faixa(1, '18:00:00', '02:00:00')]
    expect(isMerchantOpen(quarai, h, new Date('2026-11-10T23:00:00Z'))).toBe(false)
  })

  test('abre igual a fecha vale como 24 horas, a mesma convenção do service_hours', () => {
    expect(isMerchantOpen(quarai, [faixa(2, '00:00:00', '00:00:00')], terca12h)).toBe(true)
  })

  test('cidade desconhecida falha fechada', () => {
    const todosOsDias = [0, 1, 2, 3, 4, 5, 6].map((d) => faixa(d, '00:00:00', '00:00:00'))
    expect(isMerchantOpen({ ...quarai, city: 'rivera' }, todosOsDias, terca12h)).toBe(false)
    expect(isMerchantOpen(quarai, todosOsDias, terca12h)).toBe(true) // a mesma agenda abre uma cidade conhecida
  })

  test('horário malformado falha fechado em vez de lançar', () => {
    expect(isMerchantOpen(quarai, [faixa(2, 'abc', '15:00:00')], terca12h)).toBe(false)
    expect(isMerchantOpen(quarai, [faixa(2, '11:00', '15:00')], terca12h)).toBe(true) // HH:MM também é aceito
  })

  test('fora do horário de serviço do município a loja está fechada, mesmo aprovada, manual ligado e dentro da faixa', () => {
    const h = [faixa(2, '00:00:00', '00:00:00')]
    expect(isMerchantOpen(quarai, h, terca12h, false)).toBe(false)
    expect(isMerchantOpen(quarai, h, terca12h, true)).toBe(true)
  })

  test('o trailer semeado (06:00 a 00:00, atravessa a meia-noite) em todos os dias, com o serviço aberto', () => {
    const semana = [0, 1, 2, 3, 4, 5, 6].map((d) => faixa(d, '06:00:00', '00:00:00'))
    expect(isMerchantOpen(quarai, semana, new Date('2026-11-10T09:00:00Z'))).toBe(true) // 06:00
    expect(isMerchantOpen(quarai, semana, new Date('2026-11-10T08:59:00Z'))).toBe(false) // 05:59
    expect(isMerchantOpen(quarai, semana, new Date('2026-11-11T02:59:00Z'))).toBe(true) // 23:59
    expect(isMerchantOpen(quarai, semana, new Date('2026-11-11T03:00:00Z'))).toBe(false) // 00:00
  })

  test('o restaurante semeado (08:00 a 23:00) não atravessa a meia-noite', () => {
    const semana = [0, 1, 2, 3, 4, 5, 6].map((d) => faixa(d, '08:00:00', '23:00:00'))
    const artigas = { ...quarai, city: 'artigas' }
    expect(isMerchantOpen(artigas, semana, new Date('2026-11-10T11:00:00Z'))).toBe(true) // 08:00
    expect(isMerchantOpen(artigas, semana, new Date('2026-11-10T10:59:00Z'))).toBe(false)
    expect(isMerchantOpen(artigas, semana, new Date('2026-11-11T01:59:00Z'))).toBe(true) // 22:59
    expect(isMerchantOpen(artigas, semana, new Date('2026-11-11T02:00:00Z'))).toBe(false) // 23:00
  })

  test('a travessia da ponte não entra na conta: loja binacional segue só o próprio horário', () => {
    // 02:00 em Quaraí: nenhuma regra de "horário da ponte" fecha nem abre loja.
    const h = [faixa(2, '00:00:00', '04:00:00')]
    expect(isMerchantOpen({ ...quarai, city: 'artigas' }, h, new Date('2026-11-10T05:00:00Z'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------
// dinheiro de exibição
// ---------------------------------------------------------------------------------------------
describe('arredondamento de pesos na exibição', () => {
  test('o formatMoney cru arredonda 81,4 pesos para BAIXO; o helper do carrinho arredonda para cima', () => {
    // Pinça a inconsistência latente: se alguém "consertar" um lado, este teste avisa.
    expect(formatMoney(81.4, 'UYU', 'es-UY')).toBe('$U 81')
    expect(formatMoneyCeil(81.4, 'UYU', 'es-UY')).toBe('$U 82')
    expect(formatMoneyCeil(81.4, 'UYU', 'pt-BR')).toBe('$U 82')
  })

  test('um peso inteiro não sobe: 82 continua 82, e ruído de ponto flutuante não empurra 55 para 56', () => {
    expect(formatMoneyCeil(82, 'UYU', 'es-UY')).toBe('$U 82')
    expect(6.25 * 8.8).toBeGreaterThan(55) // a armadilha existe: 55.00000000000001
    expect(formatMoneyCeil(6.25 * 8.8, 'UYU', 'es-UY')).toBe('$U 55')
  })

  test('BRL não é arredondado para cima: centavos ficam como vêm', () => {
    expect(formatMoneyCeil(15, 'BRL', 'pt-BR')).toBe('R$ 15,00')
    expect(formatMoneyCeil(0.014, 'BRL', 'pt-BR')).toBe('R$ 0,01')
  })

  test('toDisplayAmount: BRL fica igual; UYU passa por convertBrlToUyu (spread e teto)', () => {
    const fx = { rate: 7.8, spreadPct: 5 }
    expect(toDisplayAmount(10, 'BRL', fx)).toBe(10)
    expect(toDisplayAmount(10, 'UYU', fx)).toBe(82) // 10 x 7,80 x 1,05 = 81,9 -> 82
    expect(toDisplayAmount(0.01, 'UYU', { rate: 7.8, spreadPct: 0 })).toBe(1) // 0,078 -> 1, nunca 0
  })

  test('toDisplayAmount aceita valor negativo (price_delta) arredondando em direção ao zero', () => {
    // -2 BRL x 7,80 x 1,05 = -16,38: o desconto mostrado é -16, não -17 (nunca prometer mais desconto do que há)
    expect(toDisplayAmount(-2, 'UYU', { rate: 7.8, spreadPct: 5 })).toBe(-16)
  })

  test('formatDisplayMoney: moeda e idioma são independentes, em todas as combinações', () => {
    const fx = { rate: 7.8, spreadPct: 5 }
    expect(formatDisplayMoney(15, 'BRL', 'pt-BR', fx)).toBe('R$ 15,00')
    expect(formatDisplayMoney(15, 'BRL', 'es-UY', fx)).toBe('R$ 15,00')
    expect(formatDisplayMoney(10, 'UYU', 'es-UY', fx)).toBe('$U 82')
    expect(formatDisplayMoney(10, 'UYU', 'pt-BR', fx)).toBe('$U 82')
    expect(formatDisplayMoney(1000, 'UYU', 'pt-BR', fx)).toBe('$U 8.190')
  })

  test('sem taxa disponível, o valor sai em reais com o símbolo R$ (nunca um peso inventado)', () => {
    expect(formatDisplayMoney(10, 'UYU', 'es-UY', null)).toBe('R$ 10,00')
  })
})

// ---------------------------------------------------------------------------------------------
// helpers de marcação
// ---------------------------------------------------------------------------------------------
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)
const texto = (markup: string) => markup.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|')
// Todo valor monetário (R$ ou $U seguido de número) do texto visível.
const precosNoTexto = (markup: string) => texto(markup).match(/(?:R\$|\$U) -?[\d.,]+/g) ?? []
// Os valores monetários que estão dentro de um elemento com class "preco". Procura cada tag de abertura (sem consumir
// o que há dentro dela) e lê o texto até o fechamento da mesma tag; elementos aninhados não escondem uns aos outros.
const precosComClasse = (markup: string) => {
  const out: string[] = []
  for (const m of markup.matchAll(/<([a-z0-9]+)\b[^>]*\bclass="([^"]*)"[^>]*>/g)) {
    if (!/(?:^|\s)preco(?:\s|$)/.test(m[2])) continue
    const resto = markup.slice(m.index! + m[0].length)
    const fim = resto.indexOf(`</${m[1]}>`)
    const dentro = texto(resto.slice(0, fim)).match(/(?:R\$|\$U) -?[\d.,]+/g)
    if (dentro) out.push(...dentro)
  }
  return out
}
// A tag de abertura do botão de adicionar. Não dá para olhar só "disabled": as classes do Tailwind têm "disabled:".
const botaoAdd = (markup: string) => markup.match(/<button[^>]*data-action="add"[^>]*>/)![0]
const desabilitado = (tag: string) => /\sdisabled(=""|\s|>)/.test(tag)

// ---------------------------------------------------------------------------------------------
// PriceSummary
// ---------------------------------------------------------------------------------------------
const quote = (over: Partial<PriceSummaryQuote> = {}): PriceSummaryQuote => ({
  breakdown: [
    { key: 'items_subtotal', labelKey: 'pricing.items_subtotal', amountBrl: 39.8 },
    { key: 'base', labelKey: 'pricing.base', amountBrl: 10 },
    { key: 'extra_km', labelKey: 'pricing.extra_km', amountBrl: 3.75 },
    { key: 'night_surcharge', labelKey: 'pricing.night_surcharge', amountBrl: 3 },
    { key: 'cross_border_fee', labelKey: 'pricing.cross_border_fee', amountBrl: 8 },
  ],
  totalBrl: 64.55,
  pricingRuleId: 'rule-1',
  distanceM: 3200,
  routeSource: 'osrm',
  crossesBorder: true,
  blocked: false,
  blockedReason: null,
  totalUyu: 529,
  fxRateUsed: 8.19,
  fxStale: false,
  ...over,
})
const resumo = (q: PriceSummaryQuote, currency: 'BRL' | 'UYU' = 'BRL', locale: 'pt-BR' | 'es-UY' = 'pt-BR') =>
  html(createElement(PriceSummary, { quote: q, currency, locale, t: catalogT }))

describe('PriceSummary', () => {
  test('PriceSummary mostra cada linha do breakdown e o total nas duas moedas', () => {
    const m = resumo(quote())
    const t = texto(m)
    for (const rotulo of ['Itens', 'Taxa de entrega', 'Quilômetro extra', 'Adicional noturno', 'Taxa de travessia']) {
      expect(t).toContain(rotulo)
    }
    for (const v of ['R$ 39,80', 'R$ 10,00', 'R$ 3,75', 'R$ 3,00', 'R$ 8,00']) expect(t).toContain(v)
    expect(t).toContain('R$ 64,55') // total em reais
    expect(t).toContain('$U 529') // total em pesos
  })

  test('o rótulo vem da labelKey traduzida, no idioma pedido', () => {
    expect(texto(resumo(quote(), 'BRL', 'es-UY'))).toContain('Tarifa de entrega')
    expect(texto(resumo(quote(), 'BRL', 'pt-BR'))).toContain('Taxa de entrega')
    expect(texto(resumo(quote({ breakdown: [{ key: 'base', labelKey: 'pricing.min_fare', amountBrl: 10 }] })))).toContain('Tarifa mínima')
  })

  test('toda chave de rótulo que o quote_order emite tem tradução nos dois idiomas', () => {
    const emitidas = [
      'pricing.base',
      'pricing.min_fare',
      'pricing.extra_km',
      'pricing.zone_surcharge',
      'pricing.night_surcharge',
      'pricing.cross_border_fee',
      'pricing.passenger_cross_border_fee',
      'pricing.items_subtotal',
    ]
    for (const k of emitidas) {
      for (const loc of ['pt-BR', 'es-UY'] as const) {
        expect(COPY[loc][k], `${k} em ${loc}`).toBeTruthy()
        expect(catalogT(k, loc)).not.toBe(k)
      }
    }
  })

  test('as duas tabelas de texto têm exatamente as mesmas chaves', () => {
    expect(Object.keys(COPY['es-UY']).sort()).toEqual(Object.keys(COPY['pt-BR']).sort())
  })

  test('o total em pesos é o do servidor, não recalculado (totalUyu diferente do que o cliente calcularia)', () => {
    // 64,55 x 8,19 = 528,6 -> 529 se o cliente recalculasse. O servidor disse 540: é 540 que aparece.
    const m = resumo(quote({ totalUyu: 540 }))
    expect(texto(m)).toContain('$U 540')
    expect(texto(m)).not.toContain('$U 529')
  })

  test('o total em reais é o do servidor, não a soma das linhas', () => {
    // linhas somam 64,55; o servidor diz 99,99 (ex.: arredondamento de regra). Quem manda é o servidor.
    const m = resumo(quote({ totalBrl: 99.99 }))
    expect(texto(m)).toContain('R$ 99,99')
    expect(texto(m)).not.toContain('R$ 64,55')
  })

  test('visualizando em pesos: as linhas seguem em reais (somam exato) e os totais saem nas duas moedas', () => {
    const t = texto(resumo(quote(), 'UYU', 'es-UY'))
    for (const v of ['R$ 39,80', 'R$ 10,00', 'R$ 3,75', 'R$ 3,00', 'R$ 8,00']) expect(t).toContain(v)
    expect(t).not.toContain('$U 326') // nenhuma linha convertida: 326+82+31+25+66 = 530 contra um total de 529 parece conta errada
    expect(t).toContain('$U 529')
    expect(t).toContain('R$ 64,55')
    expect(t.indexOf('$U 529')).toBeLessThan(t.indexOf('R$ 64,55')) // em pesos, o total em pesos vem primeiro
  })

  test('visualizando em pesos sem a taxa usada, as linhas ficam em reais em vez de inventar peso', () => {
    const t = texto(resumo(quote({ fxRateUsed: null }), 'UYU', 'es-UY'))
    expect(t).toContain('R$ 39,80')
    expect(t).not.toContain('$U 326')
  })

  test('sem totalUyu o total em pesos não aparece (o cliente não calcula o que paga)', () => {
    const t = texto(resumo(quote({ totalUyu: null })))
    expect(t).toContain('R$ 64,55')
    expect(t).not.toContain('$U')
  })

  test('cotação defasada é avisada ao cliente', () => {
    expect(texto(resumo(quote({ fxStale: true })))).toContain('Cotação desatualizada')
    expect(texto(resumo(quote({ fxStale: false })))).not.toContain('Cotação desatualizada')
  })

  test('cotação bloqueada mostra o motivo e nenhum total (total 0 não é "grátis")', () => {
    const q = quote({
      blocked: true,
      blockedReason: 'Ainda não atendemos esta região.',
      breakdown: [],
      totalBrl: 0,
      totalUyu: null,
      fxRateUsed: null,
    })
    const m = resumo(q)
    expect(texto(m)).toContain('Ainda não atendemos esta região.')
    expect(precosNoTexto(m)).toEqual([])
    expect(m).toContain('role="alert"')
  })

  test('quote bloqueada sem motivo ainda diz que não dá para fazer o pedido', () => {
    const m = resumo(quote({ blocked: true, blockedReason: null, breakdown: [], totalBrl: 0 }))
    expect(texto(m)).toContain('Não foi possível calcular o preço')
  })

  test('uma linha sem tradução mostra a própria chave em vez de sumir (o valor nunca é escondido)', () => {
    const m = resumo(quote({ breakdown: [{ key: 'novo', labelKey: 'pricing.novo_inexistente', amountBrl: 1.5 }] }))
    expect(texto(m)).toContain('pricing.novo_inexistente')
    expect(texto(m)).toContain('R$ 1,50')
  })

  test('nenhum texto sobre horário da ponte: travessia aparece só como taxa', () => {
    const t = texto(resumo(quote()))
    expect(t).not.toMatch(/ponte.*(fecha|hor[aá]rio|22)/i)
  })

  test('preço exibido usa classe de números tabulares', () => {
    const m = resumo(quote())
    const todos = precosNoTexto(m)
    expect(todos.length).toBeGreaterThan(5)
    expect(precosComClasse(m)).toEqual(todos)
    const mp = resumo(quote(), 'UYU', 'es-UY')
    expect(precosComClasse(mp)).toEqual(precosNoTexto(mp))
  })
})

// ---------------------------------------------------------------------------------------------
// componentes do catálogo
// ---------------------------------------------------------------------------------------------
const fx = { rate: 7.8, spreadPct: 5 }
const cartaoItem = (item: CatalogItem, over: Record<string, unknown> = {}) =>
  html(
    createElement(ItemCard, {
      item,
      merchant: M1,
      currency: 'BRL',
      locale: 'pt-BR',
      fx,
      t: catalogT,
      ...over,
    } as never),
  )

describe('ItemCard', () => {
  test('item sem grupo obrigatório e loja aberta: botão de adicionar habilitado', () => {
    const m = cartaoItem(agua())
    expect(desabilitado(botaoAdd(m))).toBe(false)
  })

  test('grupo obrigatório sem escolha deixa o botão desabilitado e avisa o que falta', () => {
    const m = cartaoItem(lanche())
    expect(desabilitado(botaoAdd(m))).toBe(true)
    expect(texto(m)).toContain('Escolha: Tamanho')
  })

  test('loja fechada: botão desabilitado e mensagem, mesmo sem nenhum grupo', () => {
    const m = cartaoItem(agua(), { merchant: { ...M1, isOpen: false } })
    expect(desabilitado(botaoAdd(m))).toBe(true)
    expect(texto(m)).toContain('Loja fechada')
  })

  test('item indisponível: botão desabilitado e etiqueta', () => {
    const m = cartaoItem({ ...agua(), isAvailable: false })
    expect(desabilitado(botaoAdd(m))).toBe(true)
    expect(texto(m)).toContain('Indisponível')
  })

  test('preço base em pesos passa por convertBrlToUyu: 19,90 x 7,80 x 1,05 = 162,97 -> 163', () => {
    const m = cartaoItem(lanche(), { currency: 'UYU', locale: 'es-UY' })
    expect(texto(m)).toContain('$U 163')
    expect(texto(m)).not.toContain('$U 162')
  })

  test('toda cifra do cartão (preço base e deltas) usa a classe tabular, nas duas moedas', () => {
    for (const currency of ['BRL', 'UYU'] as const) {
      const m = cartaoItem(lanche(), { currency })
      const todos = precosNoTexto(m)
      expect(todos.length).toBeGreaterThanOrEqual(4)
      expect(precosComClasse(m)).toEqual(todos)
    }
  })

  test('sem foto o cartão não quebra', () => {
    expect(cartaoItem(agua())).toContain('Água')
  })
})

describe('OptionGroup', () => {
  const render = (g: OptionGroupData, selected: string[], currency: 'BRL' | 'UYU' = 'BRL') =>
    html(createElement(OptionGroup, { group: g, selected, onToggle: () => {}, currency, locale: 'pt-BR', fx, t: catalogT } as never))

  test('mostra obrigatório e o limite, e o delta de cada opção com sinal', () => {
    const m = render(lanche().groups[1], [])
    const t = texto(m)
    expect(t).toContain('Extras')
    expect(t).toContain('até 2')
    expect(t).toContain('+R$ 2,50')
    expect(texto(render(lanche().groups[0], []))).toContain('Obrigatório')
  })

  test('opção de delta zero não mostra "+R$ 0,00"', () => {
    expect(texto(render(lanche().groups[0], []))).not.toContain('R$ 0,00')
  })

  test('opção indisponível aparece desabilitada', () => {
    const g = group({ id: 'g', options: [opt('x', 'g', 1, false)] })
    expect(render(g, [])).toMatch(/<input[^>]*disabled/)
  })

  test('com o máximo escolhido, as demais ficam desabilitadas e as escolhidas seguem ativas', () => {
    const m = render(lanche().groups[1], ['o-bacon', 'o-ovo'])
    const inputs = [...m.matchAll(/<input[^>]*>/g)].map((x) => x[0])
    expect(inputs).toHaveLength(3)
    const porId = (id: string) => inputs.find((i) => i.includes(`value="${id}"`))!
    expect(porId('o-bacon')).not.toMatch(/disabled/)
    expect(porId('o-ovo')).not.toMatch(/disabled/)
    expect(porId('o-queijo')).toMatch(/disabled/)
  })

  test('delta em pesos usa o mesmo arredondamento e a classe tabular', () => {
    const m = render(lanche().groups[1], [], 'UYU')
    // bacon +2,50 x 8,19 = 20,475 -> 21
    expect(texto(m)).toContain('+$U 21')
    expect(precosComClasse(m)).toEqual(precosNoTexto(m))
  })
})

describe('MerchantCard', () => {
  const loja = {
    id: 'm1',
    name: 'Trailer do Zé',
    kind: 'trailer',
    city: 'quarai',
    country: 'BR',
    address_text: 'Praça central',
    prep_time_min: 15,
    logo_url: null,
    cover_url: null,
    accepts_cross_border: true,
  }
  const card = (isOpen: boolean, locale: 'pt-BR' | 'es-UY' = 'pt-BR') =>
    html(createElement(MerchantCard, { merchant: loja, isOpen, locale, t: catalogT } as never))

  test('loja aberta mostra Aberta e linka para o cardápio', () => {
    const m = card(true)
    expect(texto(m)).toContain('Aberta')
    expect(m).toContain('href="/lojas/m1"')
    expect(m).toContain('data-open="true"')
  })

  test('loja fechada aparece como fechada', () => {
    const m = card(false)
    expect(texto(m)).toContain('Fechada')
    expect(texto(m)).not.toContain('Aberta')
    expect(m).toContain('data-open="false"')
  })

  test('mostra cidade com bandeira do país e o tempo de preparo', () => {
    const m = texto(card(true))
    expect(m).toContain('Quaraí')
    expect(m).toContain('🇧🇷')
    expect(m).toContain('15 min')
    expect(texto(card(true, 'es-UY'))).toContain('Abierto')
  })

  test('o cartão não expõe comissão nem nada além das colunas públicas', () => {
    expect(card(true).toLowerCase()).not.toContain('comiss')
    expect(card(true).toLowerCase()).not.toContain('commission')
  })
})

describe('Cart', () => {
  const cheio = (): CartState => {
    const s = novoStore()
    s.addItem(M1, lanche(), ['o-g', 'o-bacon'], 2) // (19,90+4,10+2,50) x 2 = 53,00
    s.addItem(M1, agua(), [], 1) // 5,00
    return s.getState()
  }
  const render = (state: CartState, currency: 'BRL' | 'UYU' = 'BRL', locale: 'pt-BR' | 'es-UY' = 'pt-BR') =>
    html(createElement(Cart, { state, currency, locale, fx, t: catalogT } as never))

  test('mostra as linhas com opções, quantidade e o subtotal estimado de itens', () => {
    const m = render(cheio())
    const t = texto(m)
    expect(t).toContain('X-Salada')
    expect(t).toContain('bacon')
    expect(t).toContain('R$ 58,00') // subtotal
    expect(t).toContain('Estimativa')
  })

  const subtotalDe = (markup: string) =>
    texto(markup.match(/data-testid="cart-subtotal"[^>]*>[\s\S]*?<\/(?:p|div|dd)>/)?.[0] ?? '')

  test('subtotal em pesos: converte o subtotal em reais uma vez, arredondando para cima', () => {
    // 58,00 x 7,80 x 1,05 = 475,02 -> 476
    expect(subtotalDe(render(cheio(), 'UYU', 'es-UY'))).toContain('$U 476')
  })

  test('o subtotal é UMA conversão do total em reais, não a soma das linhas já arredondadas', () => {
    // 7 itens de R$ 0,10. Cada linha em pesos: ceil(0,10 x 8,19 = 0,819) = 1, e 7 linhas somariam 7.
    // O subtotal certo converte 0,70 uma vez: ceil(5,733) = 6.
    const s = novoStore()
    for (let i = 0; i < 7; i++) s.addItem(M1, { ...agua(), id: `x${i}`, priceBrl: 0.1 }, [], 1)
    const sub = subtotalDe(render(s.getState(), 'UYU', 'es-UY'))
    expect(sub).toContain('$U 6')
    expect(sub).not.toContain('$U 7')
  })

  test('carrinho vazio mostra a mensagem e nenhum preço', () => {
    const m = render(novoStore().getState())
    expect(texto(m)).toContain('Seu carrinho está vazio')
    expect(precosNoTexto(m)).toEqual([])
  })

  test('toda cifra do carrinho usa a classe tabular nas duas moedas', () => {
    for (const currency of ['BRL', 'UYU'] as const) {
      const m = render(cheio(), currency)
      expect(precosNoTexto(m).length).toBeGreaterThanOrEqual(3)
      expect(precosComClasse(m)).toEqual(precosNoTexto(m))
    }
  })

  test('diz de qual loja é o carrinho', () => {
    expect(texto(render(cheio()))).toContain('Trailer do Zé')
  })
})

// ---------------------------------------------------------------------------------------------
// leitura do catálogo (linhas do PostgREST -> formas da tela)
// ---------------------------------------------------------------------------------------------
describe('mapeamento do catálogo', () => {
  const linha = (over: Partial<ItemRow> = {}): ItemRow => ({
    id: 'i1',
    merchant_id: 'm1',
    category_id: 'c1',
    name: 'X-Salada',
    description: null,
    price_brl: '19.90', // numeric pode chegar como texto
    photo_url: null,
    is_available: true,
    sort_order: 0,
    item_option_groups: [
      {
        id: 'g1',
        name: 'Tamanho',
        min_select: 0,
        max_select: 1,
        is_required: true,
        item_options: [
          { id: 'o1', group_id: 'g1', name: 'P', price_delta_brl: '0.00', is_available: true },
          { id: 'o2', group_id: 'g1', name: 'G', price_delta_brl: 4.1, is_available: true },
        ],
      },
    ],
    ...over,
  })

  test('preço e delta viram número, e o item mapeado entra no subtotal certo', () => {
    const item = toItem(linha())!
    expect(item.priceBrl).toBe(19.9)
    expect(item.groups[0].options.map((o) => o.priceDeltaBrl)).toEqual([0, 4.1])
    const s = novoStore()
    s.addItem(M1, item, ['o2'])
    expect(s.subtotalBrl()).toBe(24)
  })

  test('preço ilegível ou negativo derruba só o item, não a página', () => {
    expect(toItem(linha({ price_brl: 'abc' }))).toBeNull()
    expect(toItem(linha({ price_brl: -1 }))).toBeNull()
    expect(buildMenu([{ id: 'c1', name: 'Lanches', sort_order: 0 }], [linha({ price_brl: 'abc' }), linha({ id: 'i2' })])[0].items.map((i) => i.id)).toEqual(['i2'])
  })

  test('opção com delta ilegível some em vez de aparecer de graça', () => {
    const row = linha()
    row.item_option_groups![0].item_options![1].price_delta_brl = 'x'
    expect(toItem(row)!.groups[0].options.map((o) => o.id)).toEqual(['o1'])
  })

  test('grupo obrigatório sem nenhuma opção disponível torna o item indisponível (o pedido nunca fecharia)', () => {
    const row = linha()
    row.item_option_groups![0].item_options!.forEach((o) => (o.is_available = false))
    expect(toItem(row)!.isAvailable).toBe(false)
    expect(toItem(linha())!.isAvailable).toBe(true)
    expect(toItem(linha({ is_available: false }))!.isAvailable).toBe(false)
  })

  test('seções seguem sort_order das categorias; item sem categoria vai para uma seção final', () => {
    const menu = buildMenu(
      [
        { id: 'c2', name: 'Bebidas', sort_order: 2 },
        { id: 'c1', name: 'Lanches', sort_order: 1 },
        { id: 'c3', name: 'Vazia', sort_order: 3 },
      ],
      [
        linha({ id: 'a', category_id: 'c2', sort_order: 1 }),
        linha({ id: 'b', category_id: 'c1', sort_order: 2 }),
        linha({ id: 'c', category_id: 'c1', sort_order: 1 }),
        linha({ id: 'd', category_id: null }),
        linha({ id: 'e', category_id: 'categoria-sumida' }),
      ],
    )
    expect(menu.map((s) => s.name)).toEqual(['Lanches', 'Bebidas', null]) // categoria vazia não aparece
    expect(menu[0].items.map((i) => i.id)).toEqual(['c', 'b'])
    expect(menu[2].items.map((i) => i.id).sort()).toEqual(['d', 'e'])
  })

  test('cardápio vazio gera zero seções', () => {
    expect(buildMenu([], [])).toEqual([])
  })
})

describe('horário de serviço vindo do banco', () => {
  const rpc = (impl: () => { data: unknown; error: { code?: string } | null }) => {
    const calls: [string, Record<string, unknown>][] = []
    return {
      calls,
      client: {
        rpc: async (name: string, args: Record<string, unknown>) => {
          calls.push([name, args])
          return impl()
        },
      },
    }
  }
  const at = new Date('2026-11-10T15:00:00Z')

  test('pergunta is_within_service_hours por cidade, tipo food, no instante dado (uma vez por cidade)', async () => {
    const r = rpc(() => ({ data: true, error: null }))
    const w = await loadServiceWindows(r.client as never, ['quarai', 'artigas', 'quarai'], at)
    expect(r.calls).toHaveLength(2)
    expect(r.calls[0][0]).toBe('is_within_service_hours')
    expect(r.calls.map((c) => c[1])).toEqual([
      { p_city: 'quarai', p_kind: 'food', p_at: at.toISOString() },
      { p_city: 'artigas', p_kind: 'food', p_at: at.toISOString() },
    ])
    expect(w.get('quarai')).toBe(true)
    expect(w.get('artigas')).toBe(true)
  })

  test('resposta falsa fecha; erro e resposta que não é booleano true também fecham (falha fechado)', async () => {
    const silencio = console.error
    console.error = () => {}
    try {
      const f = await loadServiceWindows(rpc(() => ({ data: false, error: null })).client as never, ['quarai'], at)
      expect(f.get('quarai')).toBe(false)
      const e = await loadServiceWindows(rpc(() => ({ data: null, error: { code: '55000' } })).client as never, ['quarai'], at)
      expect(e.get('quarai')).toBe(false)
      const e2 = await loadServiceWindows(rpc(() => ({ data: true, error: { code: 'X' } })).client as never, ['quarai'], at)
      expect(e2.get('quarai')).toBe(false)
      const n = await loadServiceWindows(rpc(() => ({ data: 'true', error: null })).client as never, ['quarai'], at)
      expect(n.get('quarai')).toBe(false)
    } finally {
      console.error = silencio
    }
  })
})

describe('cotação defasada visível', () => {
  test('cotação do dia: sem aviso', () => {
    expect(fxNoteFrom({ isStale: false, validForDate: '2026-11-10' }, '2026-11-10')).toBeUndefined()
  })

  test('última cotação gravada, de dia anterior: aviso com a data DD/MM', () => {
    expect(fxNoteFrom({ isStale: true, validForDate: '2026-11-08' }, '2026-11-10')).toEqual({ kind: 'dated', date: '08/11' })
  })

  test('taxa padrão (getEffectiveRate devolve a data de HOJE com isStale): aviso de aproximada, nunca "cotação de hoje"', () => {
    expect(fxNoteFrom({ isStale: true, validForDate: '2026-11-10' }, '2026-11-10')).toEqual({ kind: 'default' })
    expect(fxNoteFrom({ isStale: true, validForDate: '2026-11-12' }, '2026-11-10')).toEqual({ kind: 'default' })
    expect(fxNoteFrom({ isStale: true, validForDate: 'lixo' }, '2026-11-10')).toEqual({ kind: 'default' })
  })

  type Nota = { kind: 'dated'; date: string } | { kind: 'default' } | undefined
  const nota = (currency: 'BRL' | 'UYU', note: Nota, locale: 'pt-BR' | 'es-UY' = 'pt-BR') =>
    html(createElement(FxNote, { currency, locale, fx: { rate: 7.8, spreadPct: 5, note } }))

  test('em pesos o aviso diz a data, nos dois idiomas', () => {
    expect(texto(nota('UYU', { kind: 'dated', date: '08/11' }))).toContain('cotação de 08/11')
    expect(texto(nota('UYU', { kind: 'dated', date: '08/11' }, 'es-UY'))).toContain('cotización del 08/11')
    expect(texto(nota('UYU', { kind: 'default' }))).toContain('aproximada')
  })

  test('em reais, ou com cotação do dia, não há aviso', () => {
    expect(nota('BRL', { kind: 'dated', date: '08/11' })).toBe('')
    expect(nota('UYU', undefined)).toBe('')
    expect(html(createElement(FxNote, { currency: 'UYU', locale: 'pt-BR', fx: null }))).toBe('')
  })

  test('o carrinho em pesos mostra o aviso ao lado do subtotal; em reais não', () => {
    const s = novoStore()
    s.addItem(M1, agua(), [], 1)
    const render = (currency: 'BRL' | 'UYU') =>
      html(createElement(Cart, { state: s.getState(), currency, locale: 'pt-BR', fx: { rate: 7.8, spreadPct: 5, note: { kind: 'dated', date: '08/11' } } }))
    expect(texto(render('UYU'))).toContain('cotação de 08/11')
    expect(texto(render('BRL'))).not.toContain('cotação de')
  })
})
