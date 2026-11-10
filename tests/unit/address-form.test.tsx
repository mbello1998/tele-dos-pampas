// @vitest-environment jsdom
// tests/unit/address-form.test.tsx
// Seletor de endereço em três camadas (spec 9.2). Roda em jsdom, sem testing-library: o helper abaixo
// monta com react-dom/client e dispara eventos nativos. O que só um navegador real prova (nenhum byte
// do dataset antes do foco, o Leaflet em chunk próprio) fica em tests/e2e/address.spec.ts.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { normalizeStreetName } from '@/lib/geo/normalize'
import { haversineMeters } from '@/lib/geo/distance'
import type { City, Country, LatLng, Street, StreetDataset } from '@/lib/geo/types'

// ---------------------------------------------------------------------------------------------
// Dublês: a Server Action e o Leaflet. A ação é trocada na borda do módulo (vi.mock), então o
// AddressForm exercita a ligação de verdade: o que ele manda é o que o stub recebe.
// ---------------------------------------------------------------------------------------------
const spies = vi.hoisted(() => ({
  save: vi.fn(),
  leafletImported: false,
  leafletProps: null as null | Record<string, unknown>,
}))

vi.mock('@/actions/addresses', () => ({ saveAddress: spies.save }))
// O módulo real da ação entra à parte (vi.importActual); só o cliente do Supabase é trocado.
const sb = vi.hoisted(() => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: sb.createClient }))
vi.mock('@/components/map/LeafletMap', () => {
  spies.leafletImported = true
  return {
    default: (props: Record<string, unknown>) => {
      spies.leafletProps = props
      return createElement('div', { 'data-testid': 'leaflet' })
    },
  }
})

import { AddressForm, borderMismatch } from '@/components/address/AddressForm'
import { deriveBlocks, distanceToStreetMeters, streetAnchor } from '@/components/address/BlockPicker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const root = resolve(__dirname, '../..')
const readDataset = (city: string) =>
  JSON.parse(readFileSync(join(root, 'public/data', `${city}.json`), 'utf8')) as StreetDataset
const real = [readDataset('quarai'), readDataset('artigas')]

// ---------------------------------------------------------------------------------------------
// Dataset sintético, determinístico: uma rua reta leste-oeste com três esquinas.
//   lng: -56.4600 ........ A(-56.4580) .. B(-56.4560) .. C(-56.4540) ........ -56.4500   (lat fixa)
// Blocos esperados: [início..A] (fim), A-B, B-C, [C..fim] (fim).
// ---------------------------------------------------------------------------------------------
const LAT = -30.39
// Pontos médios saem arredondados em 5 casas (~1 m): "sobre a rua" tem essa folga.
const MARGEM_M = 2
const pt = (lng: number, lat = LAT): LatLng => ({ lat, lng })
const corner = (name: string, lng: number) => ({ streetId: `quarai-${normalizeStreetName(name)}`, streetName: name, at: pt(lng) })

function mk(name: string, city: City, country: Country, segments: LatLng[][], intersections: Street['intersections'] = []): Street {
  return { id: `${city}-${normalizeStreetName(name).replace(/ /g, '-')}`, name, nameNormalized: normalizeStreetName(name), city, country, segments, intersections }
}

const ruaTeste = mk(
  'Rua Teste',
  'quarai',
  'BR',
  [[pt(-56.46), pt(-56.458), pt(-56.457), pt(-56.456), pt(-56.454), pt(-56.45)]],
  [corner('Rua Alfa', -56.458), corner('Rua Beta', -56.456), corner('Rua Gama', -56.454)],
)
const ruaSemEsquinas = mk('Rua Sem Esquinas', 'quarai', 'BR', [[pt(-56.47), pt(-56.469)]])
const calleUruguaia = mk('Calle Uruguaia', 'artigas', 'UY', [[pt(-56.48, -30.4), pt(-56.479, -30.4)]], [
  { streetId: 'artigas-x', streetName: 'Calle X', at: pt(-56.4795, -30.4) },
])
// A rua cabe numa lista de um dataset só: o formulário carrega os dois, o resto fica vazio.
const synthetic: StreetDataset[] = [
  { city: 'quarai', country: 'BR', streets: [ruaTeste, ruaSemEsquinas], references: [] },
  { city: 'artigas', country: 'UY', streets: [calleUruguaia], references: [] },
]

// ---------------------------------------------------------------------------------------------
// Helpers de DOM
// ---------------------------------------------------------------------------------------------
let mounted: { root: Root; container: HTMLElement }[] = []

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function mount(el: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const r = createRoot(container)
  await act(async () => r.render(el))
  mounted.push({ root: r, container })
  return container
}

async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function click(el: Element) {
  await act(async () => (el as HTMLElement).click())
}
async function focus(el: HTMLElement) {
  await act(async () => el.focus())
}

const q = <T extends Element = HTMLElement>(c: ParentNode, sel: string) => c.querySelector<T>(sel)
const qa = (c: ParentNode, sel: string) => Array.from(c.querySelectorAll<HTMLElement>(sel))
const button = (c: ParentNode, re: RegExp) =>
  Array.from(c.querySelectorAll('button')).find((b) => re.test(b.textContent ?? ''))
const streetInput = (c: ParentNode) => q<HTMLInputElement>(c, '[role=combobox]')!
const options = (c: ParentNode) => qa(c, '[role=option]')
const blockRadios = (c: ParentNode) => qa(c, 'input[name=block]') as HTMLInputElement[]
const radioLabel = (r: HTMLInputElement) => r.closest('label')?.textContent ?? ''

const syntheticLoader = () => Promise.resolve(synthetic)
const echo = async (input: Record<string, unknown>) => ({ id: 'addr-1', isDefault: true, ...input })

beforeEach(() => {
  spies.save.mockReset()
  spies.save.mockImplementation(echo)
  spies.leafletProps = null
  Object.defineProperty(navigator, 'geolocation', { value: undefined, configurable: true })
})
afterEach(async () => {
  await act(async () => mounted.forEach((m) => m.root.unmount()))
  mounted.forEach((m) => m.container.remove())
  mounted = []
  vi.restoreAllMocks()
})

/** Monta o formulário com o dataset sintético, busca e escolhe "Rua Teste". */
async function formComTeste(extra: Record<string, unknown> = {}) {
  const onDone = vi.fn()
  const c = await mount(createElement(AddressForm, { onDone, loadDatasets: syntheticLoader, ...extra }))
  await focus(streetInput(c))
  await flush()
  await typeInto(streetInput(c), 'teste')
  await click(options(c)[0])
  return { c, onDone }
}
const salvar = (c: ParentNode) => button(c, /salvar endere/i)!
const refInput = (c: ParentNode) => q<HTMLTextAreaElement>(c, 'textarea[name=reference]')!

function stubGeolocation(result: { coords: { latitude: number; longitude: number; accuracy: number } } | { code: number }) {
  const getCurrentPosition = vi.fn((ok: (p: unknown) => void, fail: (e: unknown) => void) =>
    'coords' in result ? ok(result) : fail({ code: result.code, message: 'x' }),
  )
  Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition }, configurable: true })
  return getCurrentPosition
}

// =============================================================================================
// Camada 0: busca de rua
// =============================================================================================
describe('busca de rua', () => {
  test('digitar 3 letras lista ruas com nome da cidade e bandeira do país', async () => {
    const c = await mount(createElement(AddressForm, { onDone: vi.fn(), loadDatasets: () => Promise.resolve(real) }))
    await focus(streetInput(c))
    await flush()
    await typeInto(streetInput(c), 'ben')
    const bento = options(c).find((o) => /Bento Gon/.test(o.textContent ?? ''))
    expect(bento, 'Rua Bento Gonçalves deveria aparecer para "ben"').toBeDefined()
    expect(bento!.textContent).toContain('Quaraí')
    expect(bento!.textContent).toContain('Brasil')
    expect(bento!.textContent).toContain('🇧🇷')

    await typeInto(streetInput(c), 'ibirapita')
    const uy = options(c)[0]
    expect(uy.textContent).toContain('Artigas')
    expect(uy.textContent).toContain('Uruguai')
    expect(uy.textContent).toContain('🇺🇾')
  })

  test('menos de 3 letras não lista nada e avisa', async () => {
    const c = await mount(createElement(AddressForm, { onDone: vi.fn(), loadDatasets: () => Promise.resolve(real) }))
    await focus(streetInput(c))
    await flush()
    await typeInto(streetInput(c), 'be')
    expect(options(c)).toHaveLength(0)
    expect(c.textContent).toMatch(/ao menos 3 letras/i)
  })

  test('escolher "Puente de la Concordia" exige escolher o país antes de prosseguir', async () => {
    // O único nome que existe nos dois lados da ponte (verificado nos dados reais).
    const c = await mount(createElement(AddressForm, { onDone: vi.fn(), loadDatasets: () => Promise.resolve(real) }))
    await focus(streetInput(c))
    await flush()
    await typeInto(streetInput(c), 'puente de la concordia')
    const opts = options(c)
    expect(opts).toHaveLength(2)
    const texts = opts.map((o) => o.textContent ?? '')
    expect(texts.some((t) => t.includes('Artigas') && t.includes('Uruguai'))).toBe(true)
    expect(texts.some((t) => t.includes('Quaraí') && t.includes('Brasil'))).toBe(true)
    // Nada é escolhido sozinho: sem clique, o formulário não avança para a quadra nem deixa salvar.
    expect(blockRadios(c)).toHaveLength(0)
    expect(salvar(c).disabled).toBe(true)

    const br = opts.find((o) => o.textContent!.includes('Brasil'))!
    await click(br)
    expect(c.textContent).toContain('Quaraí')
    expect(blockRadios(c).length).toBeGreaterThan(0)
    // As esquinas vêm da rua brasileira, não da uruguaia: a ponte BR tem 1 esquina (Gen. Canabarro).
    expect(blockRadios(c).map(radioLabel).join(' ')).toMatch(/Canabarro/)
  })

  test('resultado de busca sempre rotula cidade e país, mesmo sem nome repetido', async () => {
    const c = await mount(createElement(AddressForm, { onDone: vi.fn(), loadDatasets: () => Promise.resolve(real) }))
    await focus(streetInput(c))
    await flush()
    let total = 0
    // "18 de julio" existe só em Artigas: sem nome repetido, ainda assim vem rotulado.
    for (const query of ['rua', 'calle', 'avenida', 'sao', '18 de julio', 'artigas', 'ibirapita', 'bento', 'concordia']) {
      await typeInto(streetInput(c), query)
      for (const o of options(c)) {
        total++
        expect(o.textContent, `"${query}": ${o.textContent}`).toMatch(/Quaraí|Artigas/)
        expect(o.textContent, `"${query}": ${o.textContent}`).toMatch(/Brasil|Uruguai/)
        expect(o.textContent, `"${query}": ${o.textContent}`).toMatch(/🇧🇷|🇺🇾/)
      }
    }
    expect(total).toBeGreaterThan(20)
    await typeInto(streetInput(c), '18 de julio')
    expect(options(c)).toHaveLength(1)
    expect(options(c)[0].textContent).toContain('Uruguai')
  })

  test('nomes divididos mostram a referência próxima: duas "Ibirapitá" não são idênticas na tela', async () => {
    const c = await mount(createElement(AddressForm, { onDone: vi.fn(), loadDatasets: () => Promise.resolve(real) }))
    await focus(streetInput(c))
    await flush()
    await typeInto(streetInput(c), 'ibirapita')
    const opts = options(c).filter((o) => o.textContent!.includes('Ibirapitá'))
    expect(opts).toHaveLength(2)
    expect(opts[0].textContent).not.toBe(opts[1].textContent)
    expect(opts.map((o) => o.textContent).join('|')).toMatch(/Escuela 65/)
    expect(opts.map((o) => o.textContent).join('|')).toMatch(/Escuela 36/)
  })

  test('o dataset só é carregado quando o campo de rua recebe foco, e só uma vez', async () => {
    const loader = vi.fn(() => Promise.resolve(synthetic))
    const c = await mount(createElement(AddressForm, { onDone: vi.fn(), loadDatasets: loader }))
    await flush()
    expect(loader).not.toHaveBeenCalled()
    await focus(streetInput(c))
    await flush()
    expect(loader).toHaveBeenCalledTimes(1)
    await act(async () => streetInput(c).blur())
    await focus(streetInput(c))
    await flush()
    expect(loader).toHaveBeenCalledTimes(1)
  })

  test('falha ao carregar o dataset mostra erro e o foco seguinte tenta de novo', async () => {
    const loader = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(synthetic)
    const c = await mount(createElement(AddressForm, { onDone: vi.fn(), loadDatasets: loader }))
    await focus(streetInput(c))
    await flush()
    expect(c.textContent).toMatch(/não foi possível carregar as ruas/i)
    await click(button(c, /tentar de novo/i)!)
    await flush()
    expect(loader).toHaveBeenCalledTimes(2)
    await typeInto(streetInput(c), 'teste')
    expect(options(c)).toHaveLength(1)
  })

  test('o dataset e o Leaflet nunca entram por import estático nos componentes do formulário', () => {
    for (const f of ['StreetPicker', 'BlockPicker', 'MapPin', 'ReferenceField', 'AddressForm']) {
      const src = readFileSync(join(root, `src/components/address/${f}.tsx`), 'utf8')
      expect(src, `${f}: import estático de dataset`).not.toMatch(/^import[^\n]*public\/data/m)
      expect(src, `${f}: import estático de dataset`).not.toMatch(/^import[^\n]*\.json['"]/m)
      expect(src, `${f}: import estático do leaflet`).not.toMatch(/^import[^\n]*['"]leaflet/m)
      expect(src, `${f}: import estático do LeafletMap`).not.toMatch(/^import[^\n]*map\/LeafletMap/m)
    }
    // E o dataset de fato entra por import() dinâmico (nada de cópia embutida no componente).
    expect(readFileSync(join(root, 'src/components/address/StreetPicker.tsx'), 'utf8')).toMatch(/import\(['"][^'"]*public\/data\/quarai\.json['"]\)/)
  })
})

// =============================================================================================
// Camada 1: quadra
// =============================================================================================
describe('rua + quadra', () => {
  test('após escolher a rua, lista as esquinas vindas de intersections', async () => {
    const { c } = await formComTeste()
    const labels = blockRadios(c).map(radioLabel)
    expect(labels.some((l) => /Rua Alfa/.test(l) && /Rua Beta/.test(l))).toBe(true)
    expect(labels.some((l) => /Rua Beta/.test(l) && /Rua Gama/.test(l))).toBe(true)
    // 4 trechos entre/depois das 3 esquinas + a opção "não sei"
    expect(labels).toHaveLength(5)
    expect(labels.at(-1)).toMatch(/não sei/i)
  })

  test('escolher quadra grava precision "quadra" e coordenada no meio do trecho', async () => {
    const { c, onDone } = await formComTeste()
    const ab = blockRadios(c).find((r) => /Alfa/.test(radioLabel(r)) && /Beta/.test(radioLabel(r)))!
    await click(ab)
    await typeInto(refInput(c), 'casa verde ao lado do posto')
    await click(salvar(c))
    await flush()
    expect(spies.save).toHaveBeenCalledTimes(1)
    const sent = spies.save.mock.calls[0][0]
    expect(sent.precision).toBe('quadra')
    expect(sent.lat).toBeCloseTo(-30.39, 5)
    expect(sent.lng).toBeCloseTo(-56.457, 5) // meio entre -56.4580 e -56.4560
    expect(sent.streetId).toBe(ruaTeste.id)
    expect(sent.city).toBe('quarai')
    expect(sent.country).toBe('BR')
    expect(sent.betweenStreets).toMatch(/Rua Alfa/)
    expect(sent.betweenStreets).toMatch(/Rua Beta/)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  test('rua sem esquinas nos dados: só "não sei", precision "rua", e a coordenada está sobre a rua', async () => {
    const onDone = vi.fn()
    const c = await mount(createElement(AddressForm, { onDone, loadDatasets: syntheticLoader }))
    await focus(streetInput(c))
    await flush()
    await typeInto(streetInput(c), 'sem esquinas')
    await click(options(c)[0])
    expect(blockRadios(c)).toHaveLength(1)
    await click(blockRadios(c)[0])
    await typeInto(refInput(c), 'portão azul')
    await click(salvar(c))
    await flush()
    const sent = spies.save.mock.calls[0][0]
    expect(sent.precision).toBe('rua')
    expect(Number.isFinite(sent.lat) && Number.isFinite(sent.lng)).toBe(true)
    expect(distanceToStreetMeters(ruaSemEsquinas, sent)).toBeLessThan(MARGEM_M)
  })

  test('sem escolher quadra nem pino não dá para salvar', async () => {
    const { c } = await formComTeste()
    await typeInto(refInput(c), 'casa verde')
    expect(salvar(c).disabled).toBe(true)
    await click(salvar(c))
    expect(spies.save).not.toHaveBeenCalled()
  })

  test('trocar de rua descarta a quadra e o pino da rua anterior', async () => {
    stubGeolocation({ coords: { latitude: -30.39003, longitude: -56.457, accuracy: 10 } })
    const { c } = await formComTeste()
    await click(blockRadios(c)[1])
    await click(button(c, /usar minha localização/i)!)
    await flush()
    await click(button(c, /trocar/i)!)
    await typeInto(streetInput(c), 'uruguaia')
    await click(options(c)[0])
    expect(blockRadios(c).some((r) => r.checked)).toBe(false)
    await typeInto(refInput(c), 'casa')
    expect(salvar(c).disabled).toBe(true)
  })
})

// =============================================================================================
// deriveBlocks: a geometria por trás do seletor
// =============================================================================================
describe('deriveBlocks', () => {
  test('rua reta com 3 esquinas: 2 trechos entre esquinas + 2 pontas, pontos médios exatos', () => {
    const blocks = deriveBlocks(ruaTeste)
    const between = blocks.filter((b) => b.kind === 'between')
    const ends = blocks.filter((b) => b.kind === 'end')
    expect(between).toHaveLength(2)
    expect(ends).toHaveLength(2)
    const ab = between.find((b) => b.from === 'Rua Alfa' && b.to === 'Rua Beta')!
    const bc = between.find((b) => b.from === 'Rua Beta' && b.to === 'Rua Gama')!
    expect(ab.midpoint).toEqual({ lat: LAT, lng: -56.457 })
    expect(bc.midpoint).toEqual({ lat: LAT, lng: -56.455 })
    expect(ends.map((e) => e.from).sort()).toEqual(['Rua Alfa', 'Rua Gama'])
    // fim antes de Alfa: meio entre -56.4600 e -56.4580
    expect(ends.find((e) => e.from === 'Rua Alfa')!.midpoint.lng).toBeCloseTo(-56.459, 5)
  })

  test('o ponto médio segue o traçado da rua, não a média das esquinas (rua em L)', () => {
    const A = { lat: -30.39, lng: -56.46 }
    const knee = { lat: -30.39, lng: -56.458 }
    const B = { lat: -30.388, lng: -56.458 }
    const L = mk('Rua do Cotovelo', 'quarai', 'BR', [[A, knee, B]], [
      { streetId: 'quarai-a', streetName: 'Rua A', at: A },
      { streetId: 'quarai-b', streetName: 'Rua B', at: B },
    ])
    const between = deriveBlocks(L).find((b) => b.kind === 'between')!
    const total = haversineMeters(A, knee) + haversineMeters(knee, B)
    // Está sobre a rua (no braço norte, depois do cotovelo) e a meio caminho do traçado.
    expect(distanceToStreetMeters(L, between.midpoint)).toBeLessThan(MARGEM_M)
    expect(between.midpoint.lng).toBeCloseTo(-56.458, 5)
    expect(between.midpoint.lat).toBeGreaterThan(-30.39)
    const percorrido = haversineMeters(A, knee) + haversineMeters(knee, between.midpoint)
    expect(Math.abs(percorrido - total / 2)).toBeLessThan(1.5)
    const naMedia = { lat: (A.lat + B.lat) / 2, lng: (A.lng + B.lng) / 2 }
    expect(haversineMeters(between.midpoint, naMedia)).toBeGreaterThan(50)
  })

  test('segmentos fora de ordem e invertidos, como vêm do OSM, dão os mesmos trechos', () => {
    const segs = ruaTeste.segments[0]
    const partes = [segs.slice(3), segs.slice(0, 2).reverse(), segs.slice(1, 4).reverse()]
    const embaralhada = { ...ruaTeste, segments: partes }
    const chave = (s: Street) =>
      deriveBlocks(s)
        .map((b) => `${b.kind}:${b.from}:${b.to ?? ''}:${b.midpoint.lat},${b.midpoint.lng}`)
        .sort()
    expect(chave(embaralhada)).toEqual(chave(ruaTeste))
  })

  test('mesma esquina com dois nomes vira um rótulo só', () => {
    const rua = mk('Rua Dupla', 'quarai', 'BR', [[pt(-56.46), pt(-56.458), pt(-56.455)]], [
      corner('Rua X', -56.458),
      corner('Rua Y', -56.458),
      corner('Rua Z', -56.455),
    ])
    const b = deriveBlocks(rua).find((x) => x.kind === 'between')!
    expect(b.from).toMatch(/Rua X/)
    expect(b.from).toMatch(/Rua Y/)
  })

  test('trecho de uns 10 m entre duas esquinas não vira opção', () => {
    const rua = mk('Rua Esquinas Coladas', 'quarai', 'BR', [[pt(-56.46), pt(-56.458), pt(-56.4579), pt(-56.455)]], [
      corner('Rua M', -56.458),
      corner('Rua N', -56.4579), // ~10 m adiante
      corner('Rua Z', -56.455),
    ])
    const bs = deriveBlocks(rua)
    expect(bs.some((b) => b.from === 'Rua M' && b.to === 'Rua N')).toBe(false)
    expect(bs.every((b) => b.lengthM >= 25)).toBe(true)
    expect(bs.some((b) => b.from === 'Rua N' && b.to === 'Rua Z')).toBe(true) // o resto da rua continua coberto
  })

  test('a mesma avenida cruzando duas vezes a poucos metros (canteiro) não vira "entre X e X"', () => {
    const rua = mk('Rua do Canteiro', 'quarai', 'BR', [[pt(-56.46), pt(-56.458), pt(-56.4575), pt(-56.455)]], [
      corner('Avenida Larga', -56.458),
      corner('Avenida Larga', -56.4575), // ~48 m adiante: passa do mínimo de quadra, mas é a mesma avenida
      corner('Rua Z', -56.455),
    ])
    const bs = deriveBlocks(rua)
    expect(bs.some((b) => b.from === 'Avenida Larga' && b.to === 'Avenida Larga')).toBe(false)
  })

  test('mas a mesma rua cruzando duas vezes bem longe uma da outra (curva longa) continua sendo um trecho', () => {
    const rua = mk('Rua da Curva Longa', 'quarai', 'BR', [[pt(-56.46), pt(-56.458), pt(-56.455)]], [
      corner('Avenida Larga', -56.458),
      corner('Avenida Larga', -56.455), // ~290 m adiante
    ])
    expect(deriveBlocks(rua).some((b) => b.from === 'Avenida Larga' && b.to === 'Avenida Larga')).toBe(true)
  })

  test('rotatória ou pista dupla: dois caminhos entre as mesmas esquinas viram um trecho só', () => {
    const rua = mk('Rua da Rotatória', 'quarai', 'BR', [
      [pt(-56.46), pt(-56.459), pt(-56.458)],
      [pt(-56.46), pt(-56.459, LAT - 0.0002), pt(-56.458)], // contorno ~5 m mais longo, ponto médio a ~22 m: ids diferentes, mesmo trecho
    ], [corner('Rua P', -56.46), corner('Rua Q', -56.458)])
    const bs = deriveBlocks(rua)
    expect(bs.filter((b) => b.from === 'Rua P' && b.to === 'Rua Q')).toHaveLength(1)
  })

  test('em todas as 512 ruas reais: pontos médios ficam sobre a rua e a âncora também', () => {
    let streets = 0
    let blocks = 0
    let semBloco = 0
    for (const d of real) {
      for (const s of d.streets) {
        streets++
        const bs = deriveBlocks(s)
        blocks += bs.length
        if (bs.length === 0) semBloco++
        expect(new Set(bs.map((b) => b.id)).size, `${s.id}: ids de bloco repetidos`).toBe(bs.length)
        for (const b of bs) {
          expect(Number.isFinite(b.midpoint.lat) && Number.isFinite(b.midpoint.lng), `${s.id}`).toBe(true)
          expect(distanceToStreetMeters(s, b.midpoint), `${s.id} / ${b.from} - ${b.to}`).toBeLessThan(MARGEM_M)
        }
        const anchor = streetAnchor(s)
        expect(distanceToStreetMeters(s, anchor), `${s.id}: âncora fora da rua`).toBeLessThan(MARGEM_M)
      }
    }
    expect(streets).toBe(512)
    expect(blocks).toBeGreaterThan(streets) // senão o seletor de quadra não ofereceria quase nada
    // Rua sem nenhum trecho utilizável cai em "não sei" (precision rua); isso deve ser exceção.
    expect(semBloco).toBeLessThan(streets * 0.1)
  })
})

// =============================================================================================
// Camada 2: pino e GPS
// =============================================================================================
describe('pino e localização', () => {
  test('usar minha localização grava precision "gps" com a posição do aparelho', async () => {
    stubGeolocation({ coords: { latitude: -30.390031, longitude: -56.457123, accuracy: 12 } })
    const { c } = await formComTeste()
    await click(button(c, /usar minha localização/i)!)
    await flush()
    await click(salvar(c)) // gps não exige referência, e dispensa a escolha de quadra
    await flush()
    const sent = spies.save.mock.calls[0][0]
    expect(sent.precision).toBe('gps')
    expect(sent.lat).toBeCloseTo(-30.390031, 6)
    expect(sent.lng).toBeCloseTo(-56.457123, 6)
  })

  test('GPS negado não bloqueia: continua em precision "quadra", com coordenada da quadra', async () => {
    const getCurrentPosition = stubGeolocation({ code: 1 })
    const { c } = await formComTeste()
    await click(button(c, /usar minha localização/i)!)
    await flush()
    expect(getCurrentPosition).toHaveBeenCalled()
    expect(c.textContent).toMatch(/permiss|negad/i) // explica o que houve, sem travar
    await click(blockRadios(c).find((r) => /Beta/.test(radioLabel(r)) && /Gama/.test(radioLabel(r)))!)
    await typeInto(refInput(c), 'sobrado amarelo')
    await click(salvar(c))
    await flush()
    const sent = spies.save.mock.calls[0][0]
    expect(sent.precision).toBe('quadra')
    expect(sent.lat).toBeCloseTo(-30.39, 5)
    expect(sent.lng).toBeCloseTo(-56.455, 5)
  })

  test('navegador sem geolocalização também não trava o fluxo', async () => {
    const { c } = await formComTeste() // navigator.geolocation === undefined (beforeEach)
    await click(button(c, /usar minha localização/i)!)
    await flush()
    expect(c.textContent).toMatch(/não está disponível|indispon/i)
    await click(blockRadios(c)[1])
    await typeInto(refInput(c), 'casa')
    expect(salvar(c).disabled).toBe(false)
  })

  test('GPS de quem está longe da rua escolhida é recusado: não vira "gps" falso', async () => {
    stubGeolocation({ coords: { latitude: -34.9, longitude: -56.16, accuracy: 20 } }) // Montevidéu
    const { c } = await formComTeste()
    await click(button(c, /usar minha localização/i)!)
    await flush()
    expect(c.textContent).toMatch(/longe da rua/i)
    await click(blockRadios(c)[1])
    await typeInto(refInput(c), 'casa')
    await click(salvar(c))
    await flush()
    const sent = spies.save.mock.calls[0][0]
    expect(sent.precision).toBe('quadra')
    expect(sent.lat).toBeCloseTo(-30.39, 4)
  })

  test('GPS impreciso (Wi-Fi de computador, 2 km) não vira "gps": o entregador iria ao lugar errado', async () => {
    stubGeolocation({ coords: { latitude: -30.39003, longitude: -56.457, accuracy: 2000 } })
    const { c } = await formComTeste()
    await click(button(c, /usar minha localização/i)!)
    await flush()
    expect(c.textContent).toMatch(/imprecisa/i)
    expect(c.textContent).not.toContain('Ponto marcado.')
    await click(blockRadios(c)[1])
    await typeInto(refInput(c), 'casa')
    await click(salvar(c))
    await flush()
    expect(spies.save.mock.calls[0][0].precision).toBe('quadra')
  })

  test('o mapa não é montado até o usuário pedir o pino', async () => {
    const loadTileUrl = vi.fn(() => Promise.resolve('https://tiles.exemplo.test/{z}/{x}/{y}.png'))
    const { c } = await formComTeste({ loadTileUrl })
    await click(blockRadios(c)[1])
    await flush()
    expect(spies.leafletImported).toBe(false) // o módulo nem foi importado
    expect(q(c, '[data-testid=leaflet]')).toBeNull()
    expect(loadTileUrl).not.toHaveBeenCalled()

    await click(button(c, /marcar no mapa/i)!)
    await flush()
    await flush()
    expect(q(c, '[data-testid=leaflet]')).not.toBeNull()
    expect(spies.leafletImported).toBe(true)
    expect(loadTileUrl).toHaveBeenCalledTimes(1)
  })

  test('a URL dos tiles vem das settings e o pino nasce no meio da quadra escolhida', async () => {
    const loadTileUrl = () => Promise.resolve('https://tiles.exemplo.test/{z}/{x}/{y}.png')
    const { c } = await formComTeste({ loadTileUrl })
    await click(blockRadios(c).find((r) => /Alfa/.test(radioLabel(r)) && /Beta/.test(radioLabel(r)))!)
    await click(button(c, /marcar no mapa/i)!)
    await flush()
    await flush()
    expect(spies.leafletProps!.tileUrl).toBe('https://tiles.exemplo.test/{z}/{x}/{y}.png')
    expect(spies.leafletProps!.position).toEqual({ lat: LAT, lng: -56.457 })
  })

  test('arrastar o pino grava precision "gps" na posição final', async () => {
    const loadTileUrl = () => Promise.resolve('https://tiles.exemplo.test/{z}/{x}/{y}.png')
    const { c } = await formComTeste({ loadTileUrl })
    await click(blockRadios(c)[1])
    await click(button(c, /marcar no mapa/i)!)
    await flush()
    await flush()
    await act(async () => (spies.leafletProps!.onChange as (p: LatLng) => void)({ lat: -30.38995, lng: -56.45512 }))
    await click(salvar(c))
    await flush()
    const sent = spies.save.mock.calls[0][0]
    expect(sent.precision).toBe('gps')
    expect(sent.lat).toBeCloseTo(-30.38995, 6)
    expect(sent.lng).toBeCloseTo(-56.45512, 6)
  })

  test('sem URL de tiles configurada o mapa não abre, avisa, e o resto segue funcionando', async () => {
    const { c } = await formComTeste({ loadTileUrl: () => Promise.resolve(null) })
    await click(blockRadios(c)[1])
    await click(button(c, /marcar no mapa/i)!)
    await flush()
    await flush()
    expect(q(c, '[data-testid=leaflet]')).toBeNull()
    expect(c.textContent).toMatch(/mapa .*indispon/i)
    await typeInto(refInput(c), 'casa')
    expect(salvar(c).disabled).toBe(false)
  })
})

// =============================================================================================
// Camada 3: referência, apelido e envio
// =============================================================================================
describe('referência, apelido e envio', () => {
  test('o campo referência explica por que importa', async () => {
    const { c } = await formComTeste()
    expect(c.textContent).toMatch(/motoboy/i)
    expect(c.textContent).toMatch(/achar|encontrar/i)
  })

  test('campo referência é obrigatório quando precision não é gps', async () => {
    const { c } = await formComTeste()
    await click(blockRadios(c)[1])
    await click(salvar(c))
    await flush()
    expect(spies.save).not.toHaveBeenCalled()
    expect(q(c, '[role=alert]')?.textContent ?? '').toMatch(/escreva uma referência/i)
    expect(refInput(c).getAttribute('aria-invalid')).toBe('true')
    expect(refInput(c).required).toBe(true)
    // só espaços também não vale
    await typeInto(refInput(c), '   ')
    await click(salvar(c))
    expect(spies.save).not.toHaveBeenCalled()
    await typeInto(refInput(c), 'casa verde')
    await click(salvar(c))
    await flush()
    expect(spies.save).toHaveBeenCalledTimes(1)
  })

  test('com GPS a referência deixa de ser obrigatória', async () => {
    stubGeolocation({ coords: { latitude: -30.39003, longitude: -56.457, accuracy: 8 } })
    const { c } = await formComTeste()
    await click(button(c, /usar minha localização/i)!)
    await flush()
    expect(refInput(c).required).toBe(false)
  })

  test('endereço salvo sem apelido recebe apelido padrão', async () => {
    const { c } = await formComTeste()
    await click(blockRadios(c)[1])
    await typeInto(q<HTMLInputElement>(c, 'input[name=number]')!, '120')
    await typeInto(refInput(c), 'casa verde')
    await click(salvar(c))
    await flush()
    expect(spies.save.mock.calls[0][0].label).toBe('Rua Teste, 120')
  })

  test('apelido padrão sem número é só o nome da rua; apelido digitado é respeitado', async () => {
    const a = await formComTeste()
    await click(blockRadios(a.c)[1])
    await typeInto(refInput(a.c), 'casa verde')
    await click(salvar(a.c))
    await flush()
    expect(spies.save.mock.calls[0][0].label).toBe('Rua Teste')
    expect(spies.save.mock.calls[0][0].number).toBe('')

    spies.save.mockClear()
    const b = await formComTeste()
    await click(blockRadios(b.c)[1])
    await typeInto(q<HTMLInputElement>(b.c, 'input[name=label]')!, 'casa da mãe')
    await typeInto(refInput(b.c), 'casa verde')
    await click(salvar(b.c))
    await flush()
    expect(spies.save.mock.calls[0][0].label).toBe('casa da mãe')
  })

  test('a referência vai no payload sem espaços sobrando', async () => {
    const { c } = await formComTeste()
    await click(blockRadios(c)[1])
    await typeInto(refInput(c), '  casa verde, do lado do posto  ')
    await click(salvar(c))
    await flush()
    expect(spies.save.mock.calls[0][0].reference).toBe('casa verde, do lado do posto')
  })

  test('toque duplo em salvar envia uma vez só', async () => {
    let release: (v: unknown) => void = () => {}
    spies.save.mockImplementation((i) => new Promise((res) => (release = () => res({ id: 'x', isDefault: true, ...i }))))
    const { c, onDone } = await formComTeste()
    await click(blockRadios(c)[1])
    await typeInto(refInput(c), 'casa verde')
    await click(salvar(c))
    await click(salvar(c))
    expect(spies.save).toHaveBeenCalledTimes(1)
    expect(salvar(c).disabled).toBe(true)
    await act(async () => release(null))
    await flush()
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  test('dois envios no mesmo instante (antes de a tela re-renderizar) também saem uma vez só', async () => {
    let release: (v: unknown) => void = () => {}
    spies.save.mockImplementation((i) => new Promise((res) => (release = () => res({ id: 'x', isDefault: true, ...i }))))
    const { c, onDone } = await formComTeste()
    await click(blockRadios(c)[1])
    await typeInto(refInput(c), 'casa verde')
    const form = q<HTMLFormElement>(c, 'form')!
    await act(async () => {
      form.requestSubmit()
      form.requestSubmit()
    })
    expect(spies.save).toHaveBeenCalledTimes(1)
    await act(async () => release(null))
    await flush()
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  test('falha ao salvar mostra erro, mantém o que foi digitado e libera o botão', async () => {
    spies.save.mockRejectedValueOnce(new Error('boom'))
    const { c, onDone } = await formComTeste()
    await click(blockRadios(c)[1])
    await typeInto(refInput(c), 'casa verde')
    await click(salvar(c))
    await flush()
    expect(onDone).not.toHaveBeenCalled()
    expect(c.textContent).toMatch(/não foi possível salvar/i)
    expect(refInput(c).value).toBe('casa verde')
    expect(salvar(c).disabled).toBe(false)
    await click(salvar(c)) // segunda tentativa funciona
    await flush()
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  test('em espanhol os rótulos mudam, a cidade e o país continuam à vista', async () => {
    const c = await mount(createElement(AddressForm, { onDone: vi.fn(), loadDatasets: syntheticLoader, locale: 'es-UY' }))
    await focus(streetInput(c))
    await flush()
    await typeInto(streetInput(c), 'uruguaia')
    expect(options(c)[0].textContent).toMatch(/Artigas/)
    expect(options(c)[0].textContent).toMatch(/Uruguay/)
    expect(c.textContent).toMatch(/Calle|calle/)
    expect(button(c, /guardar dirección/i)).toBeDefined()
  })
})

// =============================================================================================
// "Não encontrei minha rua": quem mora numa rua que o OSM não tem precisa conseguir pedir
// =============================================================================================
const CENTRO_ARTIGAS = { lat: -30.4, lng: -56.47 }
const naoAcheiMinhaRua = (c: ParentNode) => button(c, /não encontrei minha rua/i)!
const cidade = (c: ParentNode, valor: string) => q<HTMLInputElement>(c, `input[name=city][value=${valor}]`)!
const nomeDaRua = (c: ParentNode) => q<HTMLInputElement>(c, 'input[name=streetName]')!

async function formSemRua(extra: Record<string, unknown> = {}) {
  const onDone = vi.fn()
  const c = await mount(createElement(AddressForm, { onDone, loadDatasets: syntheticLoader, ...extra }))
  await click(naoAcheiMinhaRua(c))
  await flush()
  return { c, onDone }
}
async function abrirMapaEMarcar(c: ParentNode, p: LatLng) {
  await click(button(c, /marcar no mapa/i)!)
  await flush()
  await flush()
  await act(async () => (spies.leafletProps!.onChange as (p: LatLng) => void)(p))
}

describe('rua que não está no dataset', () => {
  test('a busca oferece a saída, e ela abre nome livre + cidade, sem seletor de quadra', async () => {
    const { c } = await formSemRua()
    expect(nomeDaRua(c)).not.toBeNull()
    expect(cidade(c, 'quarai')).not.toBeNull()
    expect(cidade(c, 'artigas')).not.toBeNull()
    expect(c.textContent).toMatch(/Quaraí · Brasil/)
    expect(c.textContent).toMatch(/Artigas · Uruguai/)
    expect(q(c, '[role=combobox]')).toBeNull() // o campo de busca saiu do caminho
    expect(blockRadios(c)).toHaveLength(0)
    expect(c.textContent).toMatch(/OpenStreetMap/) // o cliente sabe que a rua vai ser pedida ao mapa
  })

  test('o dataset passa a ser carregado ao entrar na saída, para conferir o lado da ponte', async () => {
    const loader = vi.fn(() => Promise.resolve(synthetic))
    const c = await mount(createElement(AddressForm, { onDone: vi.fn(), loadDatasets: loader }))
    expect(loader).not.toHaveBeenCalled()
    await click(naoAcheiMinhaRua(c))
    await flush()
    expect(loader).toHaveBeenCalledTimes(1)
  })

  test('o mapa só abre depois de escolher a cidade, e nasce no centro dela', async () => {
    const { c } = await formSemRua({ loadTileUrl: () => Promise.resolve('https://tiles.exemplo.test/{z}/{x}/{y}.png') })
    expect(button(c, /marcar no mapa/i)).toBeUndefined()
    expect(c.textContent).toMatch(/escolha a cidade/i)
    await click(cidade(c, 'artigas'))
    await click(button(c, /marcar no mapa/i)!)
    await flush()
    await flush()
    expect(spies.leafletProps!.position).toEqual(CENTRO_ARTIGAS)
  })

  test('sem ponto (pino ou GPS) não salva, mesmo com nome, cidade e referência', async () => {
    const { c } = await formSemRua()
    await click(cidade(c, 'artigas'))
    await typeInto(nomeDaRua(c), 'Calle Nueva')
    await typeInto(refInput(c), 'portón negro')
    expect(salvar(c).disabled).toBe(true)
    expect(c.textContent).toMatch(/falta marcar o ponto/i)
    await click(salvar(c))
    expect(spies.save).not.toHaveBeenCalled()
  })

  test('com GPS: grava streetId null, o nome digitado, país da cidade escolhida e a coordenada do aparelho', async () => {
    stubGeolocation({ coords: { latitude: -30.4001, longitude: -56.4795, accuracy: 10 } })
    const { c, onDone } = await formSemRua()
    await click(cidade(c, 'artigas'))
    await typeInto(nomeDaRua(c), '  Calle Nueva  ')
    await click(button(c, /usar minha localização/i)!)
    await flush()
    await typeInto(refInput(c), 'portón negro')
    await click(salvar(c))
    await flush()
    const sent = spies.save.mock.calls[0][0]
    expect(sent).toMatchObject({
      streetId: null,
      streetName: 'Calle Nueva',
      city: 'artigas',
      country: 'UY',
      precision: 'gps',
      betweenStreets: '',
      reference: 'portón negro',
      label: 'Calle Nueva',
    })
    expect(sent.lat).toBeCloseTo(-30.4001, 6)
    expect(sent.lng).toBeCloseTo(-56.4795, 6)
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  test('com o pino do mapa também, e o número entra no apelido padrão', async () => {
    const { c } = await formSemRua({ loadTileUrl: () => Promise.resolve('https://tiles.exemplo.test/{z}/{x}/{y}.png') })
    await click(cidade(c, 'quarai'))
    await typeInto(nomeDaRua(c), 'Rua do Loteamento Novo')
    await typeInto(q<HTMLInputElement>(c, 'input[name=number]')!, '45')
    await abrirMapaEMarcar(c, { lat: -30.39004, lng: -56.45901 })
    await typeInto(refInput(c), 'casa de esquina, muro azul')
    await click(salvar(c))
    await flush()
    const sent = spies.save.mock.calls[0][0]
    expect(sent).toMatchObject({ streetId: null, city: 'quarai', country: 'BR', precision: 'gps', label: 'Rua do Loteamento Novo, 45' })
    expect(sent.lat).toBeCloseTo(-30.39004, 6)
  })

  test('a referência é obrigatória mesmo com GPS (é tudo o que o entregador tem)', async () => {
    stubGeolocation({ coords: { latitude: -30.4001, longitude: -56.4795, accuracy: 10 } })
    const { c } = await formSemRua()
    await click(cidade(c, 'artigas'))
    await typeInto(nomeDaRua(c), 'Calle Nueva')
    await click(button(c, /usar minha localização/i)!)
    await flush()
    expect(refInput(c).required).toBe(true)
    await click(salvar(c))
    await flush()
    expect(spies.save).not.toHaveBeenCalled()
    expect(q(c, '[role=alert]')?.textContent ?? '').toMatch(/escreva uma referência/i)
  })

  test('sem o nome da rua não salva', async () => {
    stubGeolocation({ coords: { latitude: -30.4001, longitude: -56.4795, accuracy: 10 } })
    const { c } = await formSemRua()
    await click(cidade(c, 'artigas'))
    await click(button(c, /usar minha localização/i)!)
    await flush()
    await typeInto(refInput(c), 'portón negro')
    await typeInto(nomeDaRua(c), '   ')
    expect(salvar(c).disabled).toBe(true)
  })

  test('pino do outro lado da ponte contradiz a cidade escolhida: avisa e bloqueia (a moeda depende do país)', async () => {
    // Calle Uruguaia (Artigas) está em lat -30.40; as ruas de Quaraí do dataset sintético estão em -30.39.
    stubGeolocation({ coords: { latitude: -30.4001, longitude: -56.4795, accuracy: 10 } })
    const { c } = await formSemRua()
    await click(cidade(c, 'quarai')) // diz Quaraí, mas o ponto está colado numa rua de Artigas
    await typeInto(nomeDaRua(c), 'Calle Nueva')
    await click(button(c, /usar minha localização/i)!)
    await flush()
    await typeInto(refInput(c), 'portón negro')
    expect(q(c, '[role=alert]')?.textContent ?? '').toMatch(/Artigas \(Uruguai\).*Quaraí/)
    expect(salvar(c).disabled).toBe(true)
    await click(cidade(c, 'artigas')) // corrigir a cidade não basta: o ponto foi descartado junto
    expect(salvar(c).disabled).toBe(true)
  })

  test('"voltar à busca" devolve o campo de rua e descarta o que era da rua ausente', async () => {
    const { c } = await formSemRua()
    await click(cidade(c, 'artigas'))
    await typeInto(nomeDaRua(c), 'Calle Nueva')
    await click(button(c, /voltar à busca/i)!)
    expect(streetInput(c)).not.toBeNull()
    expect(nomeDaRua(c)).toBeNull()
    await click(naoAcheiMinhaRua(c))
    expect(nomeDaRua(c).value).toBe('')
    expect(cidade(c, 'artigas').checked).toBe(false)
  })

  test('em espanhol a saída diz "No encuentro mi calle"', async () => {
    const c = await mount(createElement(AddressForm, { onDone: vi.fn(), loadDatasets: syntheticLoader, locale: 'es-UY' }))
    expect(button(c, /no encuentro mi calle/i)).toBeDefined()
  })
})

describe('borderMismatch', () => {
  const quaraiRua = real[0].streets.find((s) => s.name === 'Rua Bento Gonçalves')!
  const artigasRua = real[1].streets.find((s) => s.name === '18 de Julio')!
  const noQuarai = quaraiRua.segments[0][0]
  const emArtigas = artigasRua.segments[0][0]

  test('ponto sobre rua de Quaraí contradiz "Artigas" e vice-versa; coincidindo com a escolha, nada', () => {
    expect(borderMismatch(noQuarai, 'artigas', real)).toBe('quarai')
    expect(borderMismatch(emArtigas, 'quarai', real)).toBe('artigas')
    expect(borderMismatch(noQuarai, 'quarai', real)).toBeNull()
    expect(borderMismatch(emArtigas, 'artigas', real)).toBeNull()
  })

  test('longe de qualquer rua (campo aberto) não dá para saber: não bloqueia', () => {
    expect(borderMismatch({ lat: -30.05, lng: -56.05 }, 'quarai', real)).toBeNull()
    // ~10 km ao sul de Artigas e ~22 km de Quaraí: "mais perto de Artigas" não prova nada a essa distância
    expect(borderMismatch({ lat: -30.6, lng: -56.45 }, 'quarai', real)).toBeNull()
    expect(borderMismatch({ lat: -30.6, lng: -56.45 }, 'artigas', real)).toBeNull()
  })
})

// =============================================================================================
// A Server Action de verdade, com o cliente do Supabase trocado por um dublê
// =============================================================================================
describe('saveAddress (servidor)', () => {
  const ok = (over: Record<string, unknown> = {}) => ({
    label: '',
    streetId: 'quarai-rua-bento-goncalves',
    streetName: 'Rua Bento Gonçalves',
    number: '12',
    complement: '',
    betweenStreets: 'Entre A e B',
    reference: 'casa verde',
    city: 'quarai',
    country: 'BR',
    lat: -30.39,
    lng: -56.457,
    precision: 'quadra',
    ...over,
  })

  function fakeDb(opts: { user?: { id: string } | null; existing?: number; failFirstWith?: string } = {}) {
    const inserted: Record<string, unknown>[] = []
    let first = true
    const insert = (row: Record<string, unknown>) => ({
      select: () => ({
        single: async () => {
          inserted.push(row)
          if (first && opts.failFirstWith) {
            first = false
            return { data: null, error: { code: opts.failFirstWith } }
          }
          return { data: { id: 'new-id', ...row }, error: null }
        },
      }),
    })
    sb.createClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: opts.user === undefined ? { id: 'user-1' } : opts.user } }) },
      from: () => ({ select: async () => ({ count: opts.existing ?? 0 }), insert }),
    })
    return inserted
  }

  const action = async () => (await vi.importActual<typeof import('@/actions/addresses')>('@/actions/addresses')).saveAddress

  beforeEach(() => sb.createClient.mockReset())

  test('quem não entrou não grava, e nada é inserido', async () => {
    const inserted = fakeDb({ user: null })
    await expect((await action())(ok() as never)).rejects.toThrow('not_authenticated')
    expect(inserted).toEqual([])
  })

  test('o dono da linha é o usuário da sessão, nunca algo vindo no corpo', async () => {
    const inserted = fakeDb()
    await (await action())({ ...ok(), profile_id: 'outra-pessoa', profileId: 'outra-pessoa' } as never)
    expect(inserted[0].profile_id).toBe('user-1')
  })

  test('grava rua, quadra, referência e coordenada; apelido vazio vira "rua, número"; texto vazio vira null', async () => {
    const inserted = fakeDb()
    const saved = await (await action())(ok({ complement: '   ' }) as never)
    expect(inserted[0]).toMatchObject({
      label: 'Rua Bento Gonçalves, 12',
      street_id: 'quarai-rua-bento-goncalves',
      between_streets: 'Entre A e B',
      reference: 'casa verde',
      complement: null,
      lat: -30.39,
      lng: -56.457,
      precision: 'quadra',
    })
    expect(saved.id).toBe('new-id')
  })

  test('o primeiro endereço vira o padrão; o segundo não', async () => {
    let inserted = fakeDb({ existing: 0 })
    await (await action())(ok() as never)
    expect(inserted[0].is_default).toBe(true)
    inserted = fakeDb({ existing: 1 })
    await (await action())(ok() as never)
    expect(inserted[0].is_default).toBe(false)
  })

  test('duas gravações simultâneas do primeiro endereço: a que perde a corrida entra sem padrão', async () => {
    const inserted = fakeDb({ existing: 0, failFirstWith: '23505' })
    const saved = await (await action())(ok() as never)
    expect(inserted.map((r) => r.is_default)).toEqual([true, false])
    expect(saved.id).toBe('new-id')
  })

  test.each([
    ['cidade inventada', { city: 'montevideo' }, 'invalid_city'],
    ['país que não é o da cidade', { country: 'UY' }, 'invalid_country'],
    ['precision inventada', { precision: 'chute' }, 'invalid_precision'],
    ['sem latitude', { lat: undefined }, 'invalid_lat'],
    ['latitude NaN', { lat: Number.NaN }, 'invalid_lat'],
    ['coordenada 0,0 (GPS que falhou)', { lat: 0, lng: 0 }, 'invalid_lat'],
    ['longitude fora da região', { lng: -40 }, 'invalid_lng'],
    ['coordenada como texto', { lat: '-30.39' }, 'invalid_lat'],
    ['quadra sem referência', { reference: '   ' }, 'invalid_reference'],
    ['referência longa demais', { reference: 'x'.repeat(201) }, 'invalid_reference'],
    ['rua sem nome', { streetName: '  ' }, 'invalid_street'],
    ['id de rua vazio', { streetId: '' }, 'invalid_street'],
  ])('recusa %s', async (_nome, over, code) => {
    const inserted = fakeDb()
    await expect((await action())(ok(over) as never)).rejects.toThrow(code)
    expect(inserted).toEqual([])
  })

  test('com GPS a referência é opcional', async () => {
    const inserted = fakeDb()
    await (await action())(ok({ precision: 'gps', reference: '' }) as never)
    expect(inserted[0].reference).toBeNull()
  })

  describe('rua fora do dataset (streetId null)', () => {
    const livre = (over: Record<string, unknown> = {}) =>
      ok({ streetId: null, streetName: 'Calle Nueva', precision: 'gps', betweenStreets: 'lixo', number: '', ...over })

    test('grava street_id null com o nome digitado (a marca para o dono achar a rua faltante)', async () => {
      const inserted = fakeDb()
      const saved = await (await action())(livre() as never)
      expect(inserted[0]).toMatchObject({ street_id: null, street_name: 'Calle Nueva', precision: 'gps', between_streets: null, label: 'Calle Nueva' })
      expect(saved.streetId).toBeNull()
    })

    test('exige referência mesmo com GPS', async () => {
      const inserted = fakeDb()
      await expect((await action())(livre({ reference: '' }) as never)).rejects.toThrow('invalid_reference')
      expect(inserted).toEqual([])
    })

    test.each(['quadra', 'rua'])('exige ponto: precision "%s" sem rua conhecida é recusada', async (precision) => {
      const inserted = fakeDb()
      await expect((await action())(livre({ precision }) as never)).rejects.toThrow('invalid_precision')
      expect(inserted).toEqual([])
    })

    test('exige o nome livre', async () => {
      await expect((await action())(livre({ streetName: '' }) as never)).rejects.toThrow('invalid_street')
    })
  })
})

// =============================================================================================
// settings['map.tile_url']: lida do PostgREST, validada, nunca embutida no código
// =============================================================================================
describe('fetchTileUrl', () => {
  const carregar = async () => (await import('@/components/address/MapPin')).fetchTileUrl
  const resposta = (rows: unknown, init: { ok?: boolean } = {}) =>
    Promise.resolve({ ok: init.ok ?? true, json: () => Promise.resolve(rows) })

  beforeEach(() => {
    vi.resetModules() // o cache da URL é do módulo: cada teste começa sem ele
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://projeto.supabase.test')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_teste')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  test('lê a linha pública map.tile_url com a chave publicável e devolve o modelo', async () => {
    const fetchMock = vi.fn(() => resposta([{ value: 'https://tiles.exemplo.test/{z}/{x}/{y}.png' }]))
    vi.stubGlobal('fetch', fetchMock)
    expect(await (await carregar())()).toBe('https://tiles.exemplo.test/{z}/{x}/{y}.png')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }]
    expect(url).toContain('https://projeto.supabase.test/rest/v1/settings')
    expect(url).toContain('key=eq.map.tile_url')
    expect(url).toContain('is_public=eq.true')
    expect(init.headers.apikey).toBe('sb_publishable_teste')
  })

  test('uma só leitura por sessão da página', async () => {
    const fetchMock = vi.fn(() => resposta([{ value: 'https://t.exemplo.test/{z}/{x}/{y}.png' }]))
    vi.stubGlobal('fetch', fetchMock)
    const f = await carregar()
    await f()
    await f()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['http sem TLS', [{ value: 'http://t.exemplo.test/{z}/{x}/{y}.png' }]],
    ['sem os marcadores {z}/{x}/{y}', [{ value: 'https://t.exemplo.test/tile.png' }]],
    ['valor que não é texto', [{ value: { url: 'https://t.exemplo.test/{z}/{x}/{y}.png' } }]],
    ['javascript:', [{ value: 'javascript:alert(1)//{z}{x}{y}' }]],
    ['linha ausente', []],
  ])('valor inválido vira "mapa indisponível" (null): %s', async (_n, rows) => {
    vi.stubGlobal('fetch', vi.fn(() => resposta(rows)))
    expect(await (await carregar())()).toBeNull()
  })

  test('resposta de erro do servidor vira null', async () => {
    vi.stubGlobal('fetch', vi.fn(() => resposta([], { ok: false })))
    expect(await (await carregar())()).toBeNull()
  })

  test('falha de rede vira null e não fica gravada: abrir o mapa de novo tenta outra vez', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementation(() => resposta([{ value: 'https://t.exemplo.test/{z}/{x}/{y}.png' }]))
    vi.stubGlobal('fetch', fetchMock)
    const f = await carregar()
    expect(await f()).toBeNull()
    expect(await f()).toBe('https://t.exemplo.test/{z}/{x}/{y}.png')
  })

  test('sem as variáveis do Supabase não há leitura nem erro', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await (await carregar())()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('detalhes do pino e do teclado', () => {
  test('pino arrastado para longe da rua avisa, mas é intenção do cliente: continua valendo como "gps"', async () => {
    const loadTileUrl = () => Promise.resolve('https://tiles.exemplo.test/{z}/{x}/{y}.png')
    const { c } = await formComTeste({ loadTileUrl })
    await click(blockRadios(c)[1])
    await click(button(c, /marcar no mapa/i)!)
    await flush()
    await flush()
    await act(async () => (spies.leafletProps!.onChange as (p: LatLng) => void)({ lat: -30.3, lng: -56.4 })) // ~10 km dali
    expect(c.textContent).toMatch(/longe da rua escolhida/i)
    await typeInto(refInput(c), 'casa')
    await click(salvar(c))
    await flush()
    expect(spies.save.mock.calls[0][0].precision).toBe('gps')
  })

  test('Enter no campo de busca nunca envia o formulário (nem com a lista fechada)', async () => {
    const c = await mount(createElement(AddressForm, { onDone: vi.fn(), loadDatasets: syntheticLoader }))
    await focus(streetInput(c))
    await flush()
    await typeInto(streetInput(c), 'zzzzzz') // nada encontrado: a lista está fechada
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => void streetInput(c).dispatchEvent(ev))
    expect(ev.defaultPrevented).toBe(true)
  })
})
