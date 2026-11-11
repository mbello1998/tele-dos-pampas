// tests/unit/motion.test.tsx
// Landing e camada de movimento. Os testes que dependem de navegador real (rolagem horizontal em
// 360 px, tamanho do JS servido) ficam em tests/e2e; aqui entra tudo que dá para provar em Node.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { renderToStaticMarkup } from 'react-dom/server'
import type { StreetDataset } from '@/lib/geo/types'

const root = resolve(__dirname, '../..')

// A camada de movimento e a landing: o que esta Tarefa possui. Outras tarefas (busca de endereço,
// painel...) têm regras próprias e podem, por desenho, buscar os datasets sob demanda.
const MOTION_DIRS = ['src/components/motion', 'src/components/landing']
const MOTION_FILES = ['src/app/page.tsx', 'src/app/es/page.tsx']
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

function listFiles(dir: string, exts: string[]): string[] {
  const abs = join(root, dir)
  if (!existsSync(abs)) return []
  const out: string[] = []
  for (const name of readdirSync(abs)) {
    const rel = `${dir}/${name}`
    if (statSync(join(root, rel)).isDirectory()) out.push(...listFiles(rel, exts))
    else if (exts.some((e) => name.endsWith(e))) out.push(rel)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Dublê do navegador: só o que o código de movimento consulta.
// ---------------------------------------------------------------------------------------------
type Env = { reducedMotion: boolean; finePointer: boolean; saveData?: boolean }

function stubBrowser({ reducedMotion, finePointer, saveData = false }: Env) {
  vi.stubGlobal('window', {
    matchMedia: (query: string) => {
      let matches = false
      if (query.includes('prefers-reduced-motion: reduce')) matches = reducedMotion
      else if (query.includes('prefers-reduced-motion: no-preference')) matches = !reducedMotion
      else if (query.includes('pointer: fine')) matches = finePointer
      else if (query.includes('pointer: coarse')) matches = !finePointer
      return { matches, media: query, addEventListener() {}, removeEventListener() {} }
    },
  })
  vi.stubGlobal('navigator', { connection: { saveData, effectiveType: '4g' } })
}

/** Registra cada vez que um módulo pesado é de fato carregado. */
function mockHeavyModules() {
  const loaded: string[] = []
  vi.doMock('gsap', () => {
    loaded.push('gsap')
    const gsap = { registerPlugin() {}, matchMedia: () => ({ add() {}, revert() {} }), ticker: { add() {}, remove() {}, lagSmoothing() {} } }
    return { gsap, default: gsap }
  })
  vi.doMock('gsap/ScrollTrigger', () => {
    loaded.push('ScrollTrigger')
    const ScrollTrigger = { update() {} }
    return { ScrollTrigger, default: ScrollTrigger }
  })
  vi.doMock('lenis', () => {
    loaded.push('lenis')
    class Lenis {
      on() {}
      raf() {}
      destroy() {}
    }
    return { default: Lenis }
  })
  return loaded
}

beforeEach(() => {
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('gsap')
  vi.doUnmock('gsap/ScrollTrigger')
  vi.doUnmock('lenis')
})

// ---------------------------------------------------------------------------------------------
// Conteúdo da landing
// ---------------------------------------------------------------------------------------------
const SENTINEL = (key: string) => `«${key}»`

async function sentinelContent(locale: 'pt-BR' | 'es-UY' = 'pt-BR') {
  const { LANDING_KEYS, parseLandingContent } = await import('@/lib/landing/content')
  const item = (key: string) => ({ title: `«${key}.title»`, text: `«${key}.text»` })
  const rows = Object.values(LANDING_KEYS).map((key) => {
    if (key === 'landing_cta_href') return { key, value: '#como-funciona' }
    if (key === 'support_phone') return { key, value: '+55 55 0000-0000' }
    const isService = key.startsWith('landing_service_')
    const base = isService ? item(key) : SENTINEL(key)
    return { key, value: { 'pt-BR': base, 'es-UY': base } }
  })
  return { content: parseLandingContent(rows, locale), rows }
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

function textNodes(html: string): string[] {
  const decode = (s: string) =>
    s
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
  return [...html.matchAll(/>([^<>]+)</g)].map((m) => decode(m[1]).trim()).filter(Boolean)
}

test('textos da landing vêm de settings, não estão escritos no componente', async () => {
  const { content } = await sentinelContent()
  const { Landing } = await import('@/components/landing/Landing')
  const html = renderToStaticMarkup(<Landing content={content} locale="pt-BR" />)

  // Todo texto visível é um valor de settings (aqui, um sentinela), a marca ou um código curto.
  const permitidos = new Set(['Tele dos Pampas', 'ES', 'PT', 'BR', 'UY'])
  const sentinelas = new Set(strings(content))
  const estranhos = textNodes(html).filter((t) => !permitidos.has(t) && !sentinelas.has(t))
  expect(estranhos, 'texto escrito direto no componente').toEqual([])

  // E o inverso: cada chave de conteúdo chegou à tela.
  for (const key of ['landing_headline', 'landing_subheadline', 'landing_cta_label', 'landing_hours_notice', 'landing_closing_title']) {
    expect(html).toContain(SENTINEL(key))
  }
})

test('o locale escolhe o texto e cai para pt-BR quando falta a tradução', async () => {
  const { parseLandingContent, LANDING_KEYS } = await import('@/lib/landing/content')
  const { rows } = await sentinelContent()
  const patched = rows.map((r) =>
    r.key === 'landing_headline'
      ? { key: r.key, value: { 'pt-BR': 'em português', 'es-UY': 'en español' } }
      : r.key === 'landing_subheadline'
        ? { key: r.key, value: { 'pt-BR': 'só em português' } }
        : r,
  )
  const es = parseLandingContent(patched, 'es-UY')
  expect(es.headline).toBe('en español')
  expect(es.subheadline).toBe('só em português')
  expect(parseLandingContent(patched, 'pt-BR').headline).toBe('em português')
  expect(LANDING_KEYS.headline).toBe('landing_headline')
})

test('conteúdo obrigatório ausente em settings falha alto, com o nome da chave', async () => {
  const { parseLandingContent } = await import('@/lib/landing/content')
  const { rows } = await sentinelContent()
  const incompleto = rows.filter((r) => r.key !== 'landing_cta_label')
  expect(() => parseLandingContent(incompleto, 'pt-BR')).toThrow(/landing_cta_label/)
})

test('telefone de suporte vazio some da landing em vez de aparecer quebrado', async () => {
  const { parseLandingContent } = await import('@/lib/landing/content')
  const { rows } = await sentinelContent()
  const semTelefone = rows.map((r) => (r.key === 'support_phone' ? { key: r.key, value: '' } : r))
  expect(parseLandingContent(semTelefone, 'pt-BR').supportPhone).toBeNull()
})

test('a migração 0013 semeia as chaves de conteúdo como públicas e não usa bridge_hours', async () => {
  const { LANDING_KEYS } = await import('@/lib/landing/content')
  const sql = read('supabase/migrations/0013_landing_settings.sql')
  expect(sql).not.toMatch(/bridge_hours/)
  expect(sql).toMatch(/on conflict \(key\) do nothing/i)
  // landing_headline já nasce no seed.sql; as demais chaves são desta migração.
  for (const key of Object.values(LANDING_KEYS).filter((k) => k !== 'landing_headline')) {
    expect(sql, `chave ${key} sem semente`).toMatch(new RegExp(`\\('${key}',[\\s\\S]*?,\\s*true\\)`))
  }
  expect(sql).not.toMatch(/,\s*false\)/)
})

test('o aviso de horário diz 06:00 a 00:00 nos dois idiomas e nunca sugere que a ponte fecha', () => {
  const sql = read('supabase/migrations/0013_landing_settings.sql')
  const linha = sql.match(/\('landing_hours_notice',\s*'([^']*)'/)
  expect(linha, 'landing_hours_notice não semeada').not.toBeNull()
  const aviso = JSON.parse(linha![1]) as Record<string, string>
  for (const locale of ['pt-BR', 'es-UY']) expect(aviso[locale]).toMatch(/06:00.*00:00/)
  // A ponte é aberta 24 horas: nenhum texto semeado pode ligá-la a horário ou fechamento.
  const copy = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join(' ')
  expect(copy).not.toMatch(/ponte[^"]{0,40}(fecha|hor[aá]rio)|puente[^"]{0,40}(cierra|horario)/i)
})

// ---------------------------------------------------------------------------------------------
// reduced-motion e Lenis
// ---------------------------------------------------------------------------------------------
test('prefers-reduced-motion desliga o movimento decorativo e mantém o conteúdo visível', async () => {
  stubBrowser({ reducedMotion: true, finePointer: true })
  const loaded = mockHeavyModules()
  const { loadMotion } = await import('@/lib/motion/gsap')
  expect(await loadMotion()).toBeNull()
  expect(loaded).toEqual([]) // nem o GSAP é baixado

  // O HTML que o servidor entrega já traz todo o conteúdo visível, sem depender de JS para aparecer.
  const { content } = await sentinelContent()
  const { Landing } = await import('@/components/landing/Landing')
  const html = renderToStaticMarkup(<Landing content={content} locale="pt-BR" />)
  expect(html).toContain(SENTINEL('landing_headline'))
  expect(html).not.toMatch(/opacity:\s*0/)
  expect(html).not.toMatch(/visibility:\s*hidden/)
  expect(html).not.toMatch(/display:\s*none/)
  expect(html).not.toMatch(/stroke-dash/i)

  // E no CSS, toda animação mora dentro de `no-preference`: com reduce, nada decorativo roda.
  const css = read('src/styles/motion.css').replace(/\/\*[\s\S]*?\*\//g, '')
  const start = css.search(/@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{/)
  expect(start, 'bloco no-preference ausente').toBeGreaterThanOrEqual(0)
  let depth = 0
  let end = css.indexOf('{', start)
  for (let i = end; i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}' && --depth === 0) {
      end = i
      break
    }
  }
  const fora = css.slice(0, start) + css.slice(end + 1)
  expect(fora).not.toMatch(/@keyframes|animation\s*:|animation-name/)
})

test('Lenis não é carregado quando reduced-motion está ativo', async () => {
  stubBrowser({ reducedMotion: true, finePointer: true })
  const loaded = mockHeavyModules()
  const { startSmoothScroll } = await import('@/lib/motion/lenis')
  const motion = { gsap: { ticker: { add() {}, remove() {}, lagSmoothing() {} } }, ScrollTrigger: { update() {} } }
  const stop = await startSmoothScroll(motion as never)
  expect(loaded).not.toContain('lenis')
  expect(typeof stop).toBe('function')
})

test('Lenis entra por import dinâmico quando o movimento é permitido e o ponteiro é fino', async () => {
  stubBrowser({ reducedMotion: false, finePointer: true })
  const loaded = mockHeavyModules()
  const { startSmoothScroll } = await import('@/lib/motion/lenis')
  expect(loaded).toEqual([]) // importar o módulo não puxa o Lenis
  const motion = { gsap: { ticker: { add() {}, remove() {}, lagSmoothing() {} } }, ScrollTrigger: { update() {} } }
  await startSmoothScroll(motion as never)
  expect(loaded).toContain('lenis')
})

test('em tela de toque o Lenis também não é baixado: rolagem nativa, sem custo', async () => {
  stubBrowser({ reducedMotion: false, finePointer: false })
  const loaded = mockHeavyModules()
  const { startSmoothScroll } = await import('@/lib/motion/lenis')
  const motion = { gsap: { ticker: { add() {}, remove() {}, lagSmoothing() {} } }, ScrollTrigger: { update() {} } }
  await startSmoothScroll(motion as never)
  expect(loaded).not.toContain('lenis')
})

test('com movimento permitido o GSAP é carregado sob demanda; economia de dados o dispensa', async () => {
  stubBrowser({ reducedMotion: false, finePointer: false })
  let loaded = mockHeavyModules()
  let { loadMotion } = await import('@/lib/motion/gsap')
  expect(loaded).toEqual([])
  const motion = await loadMotion()
  expect(motion).not.toBeNull()
  expect(loaded).toContain('gsap')
  expect(loaded).toContain('ScrollTrigger')

  vi.resetModules()
  stubBrowser({ reducedMotion: false, finePointer: false, saveData: true })
  loaded = mockHeavyModules()
  ;({ loadMotion } = await import('@/lib/motion/gsap'))
  expect(await loadMotion()).toBeNull()
  expect(loaded).toEqual([])
})

// ---------------------------------------------------------------------------------------------
// StreetGridDraw: malha real
// ---------------------------------------------------------------------------------------------
const dataset = (city: 'quarai' | 'artigas') => JSON.parse(read(`public/data/${city}.json`)) as StreetDataset

test('StreetGridDraw usa a malha real do dataset, não um SVG fixo', async () => {
  const { buildMesh, frameCenter, makeProjector, GRID_VIEWBOX } = await import('@/lib/motion/grid-geometry')
  const datasets = [dataset('quarai'), dataset('artigas')]
  const mesh = buildMesh(datasets)

  // Centenas de vértices reais, nas duas cidades.
  expect(mesh.vertexCount).toBeGreaterThan(1500)
  for (const city of ['quarai', 'artigas'] as const) {
    expect(mesh.paths[city].match(/M/g)!.length, `subcaminhos de ${city}`).toBeGreaterThan(100)
  }

  // Um vértice real do dataset, projetado, aparece no caminho: a geometria vem do JSON.
  const project = makeProjector(frameCenter(datasets))
  const rua = datasets[0].streets.find((s) => {
    const p = project(s.segments[0][0])
    return p.x > 50 && p.x < GRID_VIEWBOX - 50 && p.y > 50 && p.y < GRID_VIEWBOX - 50
  })!
  const p = project(rua.segments[0][0])
  const r1 = (n: number) => Math.round(n * 10) / 10
  expect(mesh.paths.quarai).toContain(`M${r1(p.x)} ${r1(p.y)}`)

  // Mudar o dataset muda o desenho: não há SVG escrito à mão por trás.
  const alterado = structuredClone(datasets)
  alterado[0].streets = alterado[0].streets.slice(0, 20)
  expect(buildMesh(alterado).paths.quarai).not.toBe(mesh.paths.quarai)

  // A ponte vem das referências do dataset (kind === 'bridge'), com as duas cabeceiras.
  expect(mesh.bridge).not.toBeNull()
  expect(mesh.bridge!.quarai.y).toBeLessThan(mesh.bridge!.artigas.y)
})

test('StreetGridDraw busca o dataset sob demanda e o componente não traz caminhos escritos', async () => {
  const src = read('src/components/motion/StreetGridDraw.tsx')
  expect(src).toMatch(/fetch\(/)
  expect(src).toMatch(/\/data\//)
  expect(src).toMatch(/grid-simplified\.json/)
  // O componente não carrega o dataset completo (600 kB), só a malha simplificada.
  expect(src).not.toMatch(/\/data\/\$\{|quarai\.json|artigas\.json/)
  expect(src).not.toMatch(/\sd=["']M/) // nenhum <path d="M…"> literal

  // Nenhum import do JSON no código da landing e da camada de movimento: ele não pode entrar no bundle.
  // (Escopo restrito: o seletor de rua, de outra tarefa, busca o dataset sob demanda por desenho.)
  const arquivosDaLanding = [...MOTION_DIRS.flatMap((d) => listFiles(d, ['.tsx'])), ...MOTION_FILES, ...listFiles('src/lib/motion', ['.ts'])]
  expect(arquivosDaLanding.length).toBeGreaterThan(8) // o escopo não pode esvaziar sem ninguém notar
  for (const file of arquivosDaLanding) {
    expect(read(file), file).not.toMatch(/from\s+['"][^'"]*public\/data[^'"]*['"]|import\([^)]*public\/data/)
  }

  // No servidor ele entrega só o poster: o dataset de 600 kB nunca vai no HTML.
  const { StreetGridDraw } = await import('@/components/motion/StreetGridDraw')
  const html = renderToStaticMarkup(
    <StreetGridDraw posterSrc="/hero/poster-malha.svg" alt="alt" labels={{ quarai: 'Quaraí', artigas: 'Artigas', bridge: 'Ponte' }} />,
  )
  expect(html).toContain('/hero/poster-malha.svg')
  expect(html).not.toMatch(/<path/)
  expect(html.length).toBeLessThan(8_000)
})

test('a malha simplificada servida à landing sai do dataset real e é uma fração dele', async () => {
  const { buildMesh } = await import('@/lib/motion/grid-geometry')
  const datasets = [dataset('quarai'), dataset('artigas')]
  const servida = read('public/data/grid-simplified.json')
  // Defasagem: se os datasets mudarem, rode scripts/landing/build-grid.ts e build-poster.ts.
  expect(JSON.parse(servida), 'grid-simplified.json defasado em relação ao dataset').toEqual(buildMesh(datasets))

  const gz = (s: string | Buffer) => gzipSync(s, { level: 9 }).length
  const cru = gz(read('public/data/quarai.json')) + gz(read('public/data/artigas.json'))
  expect(gz(servida), `${gz(servida)} B contra ${cru} B do dataset`).toBeLessThan(cru / 5)
  expect(gz(servida)).toBeLessThan(15_000)

  // O poster desenha a mesma malha: a primeira coordenada do caminho de Quaraí aparece nele.
  const comeco = JSON.parse(servida).paths.quarai.slice(0, 20)
  expect(read('public/hero/poster-malha.svg')).toContain(comeco)
})

// ---------------------------------------------------------------------------------------------
// Só transform e opacity
// ---------------------------------------------------------------------------------------------
const ANIMAVEIS = new Set(['opacity', 'autoAlpha', 'x', 'y', 'xPercent', 'yPercent', 'scale', 'scaleX', 'scaleY', 'rotation'])
// Chaves de controle do GSAP: não animam propriedade nenhuma.
const CONTROLE = new Set([
  'duration', 'delay', 'ease', 'stagger', 'overwrite', 'immediateRender', 'paused', 'repeat', 'yoyo',
  'transformOrigin', 'force3D', 'clearProps', 'lazy', 'scrollTrigger', 'trigger', 'start', 'end', 'scrub',
  'once', 'toggleActions', 'pin', 'pinSpacing', 'anticipatePin', 'invalidateOnRefresh', 'each', 'from',
  'amount', 'onComplete', 'onUpdate', 'defaults',
])
// Única exceção, e só no desenho da malha: stroke-dashoffset repinta um SVG, mas não dispara layout.
const EXCECAO_PINTURA = 'strokeDashoffset'
const LAYOUT = /\b(width|height|top|left|right|bottom|margin\w*|padding\w*|fontSize|lineHeight|letterSpacing|backgroundPosition|borderWidth|flexBasis|gap)\s*:/

function chaves(obj: unknown, out: Set<string> = new Set()): Set<string> {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      out.add(k)
      chaves(v, out)
    }
  }
  return out
}

function chamadasGsap(src: string): string[] {
  const spans: string[] = []
  for (const m of src.matchAll(/\.(?:to|from|fromTo|set)\(/g)) {
    let depth = 1
    let i = m.index! + m[0].length
    const start = i
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '(') depth++
      if (src[i] === ')') depth--
    }
    spans.push(src.slice(start, i))
  }
  return spans
}

test('as animações alteram apenas transform e opacity', async () => {
  // 1) Tudo o que os componentes animam passa por presets; cada chave é conferida em tempo de execução.
  const { presets } = await import('@/lib/motion/presets')
  const usadas = new Set<string>()
  for (const preset of Object.values(presets) as Array<Record<string, unknown>>) {
    for (const lado of ['from', 'to', 'set']) chaves(preset[lado], usadas)
  }
  const intrusas = [...usadas].filter((k) => !ANIMAVEIS.has(k) && !CONTROLE.has(k) && k !== EXCECAO_PINTURA)
  expect(intrusas, 'propriedade fora de transform/opacity').toEqual([])
  // A exceção de pintura existe só no preset do desenho da malha.
  const comDash = Object.entries(presets)
    .filter(([, v]) => ['from', 'to', 'set'].some((lado) => chaves((v as Record<string, unknown>)[lado]).has(EXCECAO_PINTURA)))
    .map(([k]) => k)
  expect(comDash).toEqual(['gridStroke'])

  // 2) Nenhuma chamada gsap.to/from/fromTo/set do código traz propriedade de layout.
  const arquivos = [...MOTION_DIRS.flatMap((d) => listFiles(d, ['.tsx'])), ...listFiles('src/lib/motion', ['.ts'])]
  for (const file of arquivos) {
    for (const call of chamadasGsap(read(file))) {
      expect(call, `${file}: propriedade de layout em tween`).not.toMatch(LAYOUT)
    }
  }

  // 3) No CSS, os @keyframes só mexem em transform e opacity. A exceção de pintura também vale aqui, e
  //    O desenho da malha da tela de pedido (`malha-desenha`, com `stroke-dashoffset`) saiu do CSS: agora é o vídeo
  //    do Remotion (IdleBackdrop), então nenhum quadro-chave pode usar a exceção. Qualquer propriedade fora de
  //    transform/opacity reprova.
  const css = read('src/styles/motion.css').replace(/\/\*[\s\S]*?\*\//g, '')
  const blocos = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)]
  expect(blocos.length).toBeGreaterThan(0)
  const comDashCss: string[] = []
  for (const [, nome, corpo] of blocos) {
    const props = [...corpo.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1])
    if (props.includes('stroke-dashoffset')) comDashCss.push(nome)
    expect(props.filter((p) => p !== 'transform' && p !== 'opacity' && p !== 'stroke-dashoffset')).toEqual([])
  }
  expect(comDashCss).toEqual([])
})

// ---------------------------------------------------------------------------------------------
// Sem WebGL e orçamento de JS
// ---------------------------------------------------------------------------------------------
test('nenhum script de WebGL ou three.js no bundle', () => {
  const pkg = JSON.parse(read('package.json'))
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  const proibidos = ['three', '@react-three/fiber', '@react-three/drei', 'ogl', 'pixi.js', 'babylonjs', '@babylonjs/core', 'regl', 'twgl.js', 'p5']
  expect(deps.filter((d) => proibidos.includes(d))).toEqual([])

  for (const file of [...listFiles('src', ['.ts', '.tsx', '.css'])]) {
    expect(read(file), file).not.toMatch(/WebGLRenderer|getContext\(\s*['"](?:experimental-)?webgl|from\s+['"]three['"]|require\(['"]three['"]\)/)
  }

  // Com um build feito, confere também os chunks que o navegador recebe.
  const chunks = join(root, '.next/static/chunks')
  if (existsSync(chunks)) {
    for (const file of listFiles('.next/static/chunks', ['.js'])) {
      expect(read(file), file).not.toMatch(/WebGLRenderer|WebGL2RenderingContext/)
    }
  }
})

// BUILD_ID, nunca app-build-manifest.json: o `next dev` TAMBÉM escreve esse manifesto, então o guarda antigo
// achava que havia build de produção e media o pacote de desenvolvimento — 2163 kB, um vermelho que não quer
// dizer nada. BUILD_ID só existe depois de `npm run build`.
const built = existsSync(join(root, '.next/BUILD_ID'))
test.skipIf(!built)('JS da rota inicial fica abaixo de 180 kB comprimido (exige npm run build)', () => {
  const app = JSON.parse(read('.next/app-build-manifest.json')) as { pages: Record<string, string[]> }
  const bm = JSON.parse(read('.next/build-manifest.json')) as { polyfillFiles?: string[]; rootMainFiles?: string[] }
  const files = new Set<string>([...(app.pages['/page'] ?? []), ...(bm.rootMainFiles ?? []), ...(bm.polyfillFiles ?? [])])
  const js = [...files].filter((f) => f.endsWith('.js'))
  expect(js.length).toBeGreaterThan(0)
  const bytes = js.reduce((sum, f) => sum + gzipSync(readFileSync(join(root, '.next', f))).length, 0)
  expect(bytes, `${(bytes / 1000).toFixed(1)} kB gzip na rota /`).toBeLessThan(180_000)
})
