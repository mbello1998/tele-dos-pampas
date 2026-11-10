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
vi.mock('@/components/map/LeafletMap', () => {
  spies.leafletImported = true
  return {
    default: (props: Record<string, unknown>) => {
      spies.leafletProps = props
      return createElement('div', { 'data-testid': 'leaflet' })
    },
  }
})

import { AddressForm } from '@/components/address/AddressForm'
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
