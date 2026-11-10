// Formas do catálogo como o cliente as vê. Os valores monetários são BRL canônico (numeric do Postgres chega como
// número no JSON do PostgREST); a conversão para pesos é só de exibição (ver money.ts).

import type { Currency, Locale } from '@/lib/money/format'

export type { Currency, Locale }

/** Taxa BRL->UYU para exibir preços de vitrine: a de `getEffectiveRate`, com o spread. Nunca é o preço cobrado. */
export type DisplayFx = { rate: number; spreadPct: number }

export type OptionData = {
  id: string
  groupId: string
  name: string
  priceDeltaBrl: number
  isAvailable: boolean
}

export type OptionGroupData = {
  id: string
  name: string
  minSelect: number
  maxSelect: number
  isRequired: boolean
  options: OptionData[]
}

export type CatalogItem = {
  id: string
  merchantId: string
  name: string
  description: string | null
  priceBrl: number
  photoUrl: string | null
  isAvailable: boolean
  groups: OptionGroupData[]
}

/** Quem está vendendo, no que o carrinho precisa saber. `isOpen` vem de `isMerchantOpen`. */
export type CartMerchant = { id: string; name: string; isOpen: boolean }

/** As colunas de `merchants_public` que a vitrine usa. Sem comissão: a view nem a tem. */
export type PublicMerchant = {
  id: string
  name: string
  kind: string
  city: string
  country: string
  address_text: string | null
  prep_time_min: number
  logo_url: string | null
  cover_url: string | null
  accepts_cross_border: boolean
}
