// A parte pura da entrega pedida pela LOJA: o que a tela manda, o que o servidor aceita e a conta de troco.
//
// A loja já vendeu o lanche pelo WhatsApp e agora chama um motoboy. A tela pergunta quatro coisas: o endereço do
// comprador, o que vai na sacola, quanto o motoboy cobra do comprador (opcional) e quem paga a entrega. O PREÇO
// DA ENTREGA NÃO ESTÁ NA LISTA: é da plataforma (tarifa de convênio, calculada em public.quote_order) e o dono
// não o digita nem o altera. O total que a tela "viu" volta ao servidor só para ser comparado, como em qualquer
// pedido (create_order recusa se divergir mais de R$ 0,01).
//
// Sem rede e sem next/*: testável em Node e usável pela ilha de cliente.
import { convertBrlToUyu } from '@/lib/money/format'

export type FeePayer = 'client' | 'merchant'
export const FEE_PAYERS: readonly FeePayer[] = ['client', 'merchant']
export type PayCurrency = 'BRL' | 'UYU'

export const MAX_LOAD = 500
/** Mesmo teto do banco (create_order recusa acima de R$ 10.000). */
export const MAX_COLLECT_BRL = 10_000

/**
 * O que basta para cotar: o endereço e QUEM PAGA. A loja de origem é a do dono da sessão, lida pelo servidor.
 * Quem paga está aqui, e não só na criação, porque é ele que escolhe a tarifa — convênio quando a loja paga,
 * balcão quando o comprador paga.
 */
export type ShopQuoteInput = { merchantId: string; dropoffAddressId: string; feePayer: FeePayer }

export type ShopCreateInput = ShopQuoteInput & {
  loadDescription: string
  /** O que o motoboy cobra do comprador pela mercadoria, em reais. null = nada a cobrar. */
  collectAmountBrl: number | null
  /** Em que dinheiro o comprador paga ao motoboy. */
  payCurrency: PayCurrency
  /** A nota que o comprador vai entregar, na moeda de `payCurrency`. */
  changeFor: number | null
  /** O total da entrega que a tela mostrou. O servidor recalcula e compara. */
  clientTotalBrl: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseShopQuoteInput(raw: unknown): ShopQuoteInput | null {
  if (!isRecord(raw) || !isUuid(raw.merchantId) || !isUuid(raw.dropoffAddressId)) return null
  // feePayer entra JÁ NA COTAÇÃO porque é ele que escolhe a tarifa: convênio (R$ 8) quando a loja paga,
  // balcão (R$ 9) quando quem paga é o comprador. Sem ele, a tela mostraria um preço e o banco cobraria outro.
  if (!FEE_PAYERS.includes(raw.feePayer as FeePayer)) return null
  return { merchantId: raw.merchantId, dropoffAddressId: raw.dropoffAddressId, feePayer: raw.feePayer as FeePayer }
}

/** Centavos exatos: 45,5 passa, 45,555 não (a coluna é numeric(10,2) e o banco recusa mais casas). */
const isCents = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.abs(Math.round(v * 100) - v * 100) < 1e-6

export function parseShopCreateInput(raw: unknown): ShopCreateInput | null {
  const base = parseShopQuoteInput(raw)
  if (!base || !isRecord(raw)) return null
  const load = typeof raw.loadDescription === 'string' ? raw.loadDescription.trim() : ''
  if (load === '' || load.length > MAX_LOAD) return null
  const collect = raw.collectAmountBrl ?? null
  if (collect !== null && !(isCents(collect) && collect <= MAX_COLLECT_BRL)) return null
  if (!FEE_PAYERS.includes(raw.feePayer as FeePayer)) return null
  if (raw.payCurrency !== 'BRL' && raw.payCurrency !== 'UYU') return null
  const changeFor = raw.changeFor ?? null
  if (changeFor !== null && !(typeof changeFor === 'number' && Number.isFinite(changeFor) && changeFor > 0 && changeFor <= 100_000_000)) return null
  if (typeof raw.clientTotalBrl !== 'number' || !Number.isFinite(raw.clientTotalBrl) || raw.clientTotalBrl < 0) return null
  return {
    ...base,
    loadDescription: load,
    // zero a cobrar é "nada a cobrar": o banco guarda null, e a tela não precisa distinguir
    collectAmountBrl: collect === null || collect === 0 ? null : collect,
    feePayer: raw.feePayer as FeePayer,
    payCurrency: raw.payCurrency,
    changeFor,
    clientTotalBrl: raw.clientTotalBrl,
  }
}

/**
 * O que o motoboy leva do comprador e o troco, para MOSTRAR. É a mesma aritmética que create_order refaz no banco
 * (mercadoria + a entrega, se o comprador é quem paga; em pesos, convertida com a taxa da cotação e arredondada
 * para cima), mas aqui nada é gravado nem cobrado: quem decide é o servidor.
 *
 * `rateUsed` é a taxa JÁ com spread (CustomerQuote.fxRateUsed), por isso o spread passado à conversão é 0.
 */
export function collectView(args: {
  collectBrl: number
  feeBrl: number
  feePayer: FeePayer
  currency: PayCurrency
  rateUsed: number | null
  changeFor: number | null
}): { owedBrl: number; owed: number | null; change: number | null } {
  const owedBrl = Math.round((args.collectBrl + (args.feePayer === 'client' ? args.feeBrl : 0)) * 100) / 100
  const owed =
    args.currency === 'BRL' ? owedBrl : args.rateUsed !== null && args.rateUsed > 0 ? convertBrlToUyu(owedBrl, args.rateUsed, 0) : null
  const change = owed !== null && args.changeFor !== null && args.changeFor >= owed ? Math.round((args.changeFor - owed) * 100) / 100 : null
  return { owedBrl, owed, change }
}
