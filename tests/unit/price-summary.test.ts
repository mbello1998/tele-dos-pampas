import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { PriceSummary, type PriceSummaryQuote } from '@/components/order/PriceSummary'
import { COPY, priceT } from '@/lib/pricing/copy'

// Estes testes vieram de tests/unit/cart.test.ts (Fatia 1b, passo 1), onde o PriceSummary era testado junto com o
// carrinho. O componente fica; o carrinho não. Mudou só o que dependia de itens: a linha "Itens" saiu da fixture e da
// lista de chaves, e os totais da fixture passaram a ser a soma das linhas que sobraram (24,75 e 203 pesos).

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

const quote = (over: Partial<PriceSummaryQuote> = {}): PriceSummaryQuote => ({
  breakdown: [
    { key: 'base', labelKey: 'pricing.base', amountBrl: 10 },
    { key: 'extra_km', labelKey: 'pricing.extra_km', amountBrl: 3.75 },
    { key: 'night_surcharge', labelKey: 'pricing.night_surcharge', amountBrl: 3 },
    { key: 'cross_border_fee', labelKey: 'pricing.cross_border_fee', amountBrl: 8 },
  ],
  totalBrl: 24.75,
  pricingRuleId: 'rule-1',
  distanceM: 3200,
  routeSource: 'osrm',
  crossesBorder: true,
  blocked: false,
  blockedReason: null,
  totalUyu: 203,
  fxRateUsed: 8.19,
  fxStale: false,
  ...over,
})
const resumo = (q: PriceSummaryQuote, currency: 'BRL' | 'UYU' = 'BRL', locale: 'pt-BR' | 'es-UY' = 'pt-BR') =>
  html(createElement(PriceSummary, { quote: q, currency, locale, t: priceT }))

describe('PriceSummary', () => {
  test('PriceSummary mostra cada linha do breakdown e o total nas duas moedas', () => {
    const m = resumo(quote())
    const t = texto(m)
    for (const rotulo of ['Taxa de entrega', 'Quilômetro extra', 'Adicional noturno', 'Taxa de travessia']) {
      expect(t).toContain(rotulo)
    }
    for (const v of ['R$ 10,00', 'R$ 3,75', 'R$ 3,00', 'R$ 8,00']) expect(t).toContain(v)
    expect(t).toContain('R$ 24,75') // total em reais
    expect(t).toContain('$U 203') // total em pesos
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
    ]
    for (const k of emitidas) {
      for (const loc of ['pt-BR', 'es-UY'] as const) {
        expect(COPY[loc][k], `${k} em ${loc}`).toBeTruthy()
        expect(priceT(k, loc)).not.toBe(k)
      }
    }
  })

  test('as duas tabelas de texto têm exatamente as mesmas chaves', () => {
    expect(Object.keys(COPY['es-UY']).sort()).toEqual(Object.keys(COPY['pt-BR']).sort())
  })

  test('o total em pesos é o do servidor, não recalculado (totalUyu diferente do que o cliente calcularia)', () => {
    // 24,75 x 8,19 = 202,7 -> 203 se o cliente recalculasse. O servidor disse 540: é 540 que aparece.
    const m = resumo(quote({ totalUyu: 540 }))
    expect(texto(m)).toContain('$U 540')
    expect(texto(m)).not.toContain('$U 203')
  })

  test('o total em reais é o do servidor, não a soma das linhas', () => {
    // linhas somam 24,75; o servidor diz 99,99 (ex.: arredondamento de regra). Quem manda é o servidor.
    const m = resumo(quote({ totalBrl: 99.99 }))
    expect(texto(m)).toContain('R$ 99,99')
    expect(texto(m)).not.toContain('R$ 24,75')
  })

  test('visualizando em pesos: as linhas seguem em reais (somam exato) e os totais saem nas duas moedas', () => {
    const t = texto(resumo(quote(), 'UYU', 'es-UY'))
    for (const v of ['R$ 10,00', 'R$ 3,75', 'R$ 3,00', 'R$ 8,00']) expect(t).toContain(v)
    expect(t).not.toContain('$U 82') // nenhuma linha convertida: 82+31+25+66 = 204 contra um total de 203 parece conta errada
    expect(t).toContain('$U 203')
    expect(t).toContain('R$ 24,75')
    expect(t.indexOf('$U 203')).toBeLessThan(t.indexOf('R$ 24,75')) // em pesos, o total em pesos vem primeiro
  })

  test('visualizando em pesos sem a taxa usada, as linhas ficam em reais em vez de inventar peso', () => {
    const t = texto(resumo(quote({ fxRateUsed: null }), 'UYU', 'es-UY'))
    expect(t).toContain('R$ 10,00')
    expect(t).not.toContain('$U 82')
  })

  test('sem totalUyu o total em pesos não aparece (o cliente não calcula o que paga)', () => {
    const t = texto(resumo(quote({ totalUyu: null })))
    expect(t).toContain('R$ 24,75')
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
