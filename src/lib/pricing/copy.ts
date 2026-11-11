// Textos do resumo de preço.
//
// Vivem aqui, e não em src/lib/i18n, porque a camada de tradução da Tarefa 8 é de outra tarefa e as chaves
// `pricing.*` que o quote_order emite (labelKey) precisam de rótulo hoje. Os componentes recebem `t` por prop
// com a assinatura do contrato, `t(key, locale)`: quando as tabelas do i18n ganharem estas chaves, basta trocar
// `priceT` pela `t` oficial. Chave sem tradução devolve a própria chave: texto feio, mas o valor ao lado dele
// nunca é escondido.
import type { Locale } from '@/lib/money/format'

export type Translate = (key: string, locale: Locale) => string

export const COPY: Record<Locale, Record<string, string>> = {
  'pt-BR': {
    // linhas do breakdown (labelKey do quote_order)
    'pricing.base': 'Taxa de entrega',
    'pricing.min_fare': 'Tarifa mínima',
    'pricing.extra_km': 'Quilômetro extra',
    'pricing.zone_surcharge': 'Sobretaxa da zona',
    'pricing.night_surcharge': 'Adicional noturno',
    'pricing.cross_border_fee': 'Taxa de travessia',
    'pricing.passenger_cross_border_fee': 'Taxa de travessia (passageiro)',
    // resumo
    'pricing.title': 'Resumo do preço',
    'pricing.total': 'Total',
    'pricing.total_brl': 'Total em reais',
    'pricing.total_uyu': 'Total em pesos',
    'pricing.stale': 'Cotação desatualizada: usamos a última disponível.',
    'pricing.blocked_title': 'Não dá para fazer este pedido',
    'pricing.blocked_fallback': 'Não foi possível calcular o preço deste pedido.',
  },
  'es-UY': {
    'pricing.base': 'Tarifa de entrega',
    'pricing.min_fare': 'Tarifa mínima',
    'pricing.extra_km': 'Kilómetro extra',
    'pricing.zone_surcharge': 'Recargo de zona',
    'pricing.night_surcharge': 'Recargo nocturno',
    'pricing.cross_border_fee': 'Tarifa de cruce',
    'pricing.passenger_cross_border_fee': 'Tarifa de cruce (pasajero)',
    'pricing.title': 'Resumen del precio',
    'pricing.total': 'Total',
    'pricing.total_brl': 'Total en reales',
    'pricing.total_uyu': 'Total en pesos',
    'pricing.stale': 'Cotización desactualizada: usamos la última disponible.',
    'pricing.blocked_title': 'No se puede hacer este pedido',
    'pricing.blocked_fallback': 'No fue posible calcular el precio de este pedido.',
  },
}

export const priceT: Translate = (key, locale) => COPY[locale][key] ?? key

/** Troca {chave} pelos valores. Chave ausente fica como está: melhor ver "{n}" do que um texto errado. */
export function fmt(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m))
}
