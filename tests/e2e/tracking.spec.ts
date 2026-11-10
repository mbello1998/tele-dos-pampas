import { type ChildProcess, spawn } from 'node:child_process'
import { expect, type Page, test } from '@playwright/test'

// Rastreio no navegador de verdade, contra o build de produção. A tela real lê o pedido do banco com a
// sessão do usuário; aqui ela roda com dados inventados (src/app/(cliente)/pedido/[code]/fixtures.ts), que só
// existem num servidor subido com TRACKING_E2E_FIXTURES=1. O spec sobe o PRÓPRIO servidor com essa variável
// (porta 3198), então o comando `npx playwright test tests/e2e/tracking.spec.ts` funciona sem configurar nada
// e o servidor da porta 3199 (sem a variável) nunca serve dado de teste.
//
// A privacidade da posição (quem lê o quê) não é testada aqui: é do banco, em tests/db/position-privacy.test.ts.
const PORT = 3198
const BASE = `http://localhost:${PORT}`
let server: ChildProcess | undefined

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(PORT)], {
    env: { ...process.env, TRACKING_E2E_FIXTURES: '1' },
    stdio: 'ignore',
  })
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      const res = await fetch(`${BASE}/`)
      if (res.ok) return
    } catch {
      /* ainda subindo */
    }
    if (Date.now() > deadline) throw new Error('o servidor do rastreio (porta 3198) não subiu em 60 s')
    await new Promise((r) => setTimeout(r, 500))
  }
})
test.afterAll(() => {
  server?.kill()
})

// PNG 1x1 transparente.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const timelineOrder = (page: Page) => page.locator('[data-timeline] li').evaluateAll((els) => els.map((e) => e.getAttribute('data-status')))

test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true })

test('sem posição nenhuma, a página mostra a timeline e não quebra', async ({ page }) => {
  const erros: string[] = []
  page.on('pageerror', (e) => erros.push(e.message))
  const tiles: string[] = []
  page.on('request', (r) => r.url().includes('tiles.e2e.test') && tiles.push(r.url()))

  await page.goto(`${BASE}/pedido/E2E-SEM-POSICAO`, { waitUntil: 'networkidle' })

  await expect(page.locator('[data-waiting-signal]')).toBeVisible()
  await expect(page.locator('[data-current-status]')).toHaveText('Motoboy a caminho')
  // a timeline vem de order_events (o fixture os entrega fora de ordem)
  expect(await timelineOrder(page)).toEqual(['criado', 'aguardando_motoboy', 'aceito'])
  await expect(page.locator('[data-courier-map], [data-courier-marker], [data-map-fallback]')).toHaveCount(0)
  expect(tiles).toEqual([]) // sem posição não se gasta um byte de tile
  expect(erros).toEqual([])
  await expect(page.locator('[data-addresses]')).toContainText('Rua Uruguai, 120')
})

test('falha de tiles mostra endereço em texto e mantém a timeline', async ({ page }) => {
  await page.route('**/tiles.e2e.test/**', (route) => route.abort())
  const erros: string[] = []
  page.on('pageerror', (e) => erros.push(e.message))

  await page.goto(`${BASE}/pedido/E2E-COM-MAPA`, { waitUntil: 'networkidle' })

  const fallback = page.locator('[data-map-fallback]')
  await expect(fallback).toBeVisible({ timeout: 15_000 })
  await expect(fallback).toContainText('Mapa indisponível')
  await expect(fallback).toContainText('Calle Lecueder, 45')
  await expect(page.locator('[data-courier-marker]')).toHaveCount(0)
  // a timeline segue inteira, em ordem
  expect(await timelineOrder(page)).toEqual(['criado', 'aguardando_motoboy', 'aceito', 'coletado'])
  await expect(page.locator('[data-current-status]')).toHaveText('A caminho de você')
  expect(erros).toEqual([])
})

test('com tiles, o marcador aparece posicionado por transform e o provedor vem da setting', async ({ page }) => {
  const pedidos: string[] = []
  await page.route('**/tiles.e2e.test/**', (route) => {
    pedidos.push(route.request().url())
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
  })
  await page.goto(`${BASE}/pedido/E2E-COM-MAPA`, { waitUntil: 'networkidle' })

  await expect(page.locator('[data-courier-map]')).toBeVisible()
  const marker = page.locator('[data-courier-marker]')
  await expect(marker).toBeVisible()
  const style = await marker.evaluate((el) => ({ inline: (el as HTMLElement).style.transform, left: (el as HTMLElement).style.left, top: (el as HTMLElement).style.top }))
  expect(style.inline).toMatch(/translate3d\(/)
  expect(style.left + style.top).toBe('') // nunca por left/top
  await expect(page.locator('[data-destination-pin]')).toBeVisible()
  await expect(page.locator('[data-courier-map]')).toContainText('© e2e')

  // as URLs dos tiles vêm do modelo da setting (z/x/y preenchidos), e é um punhado deles, não centenas
  expect(pedidos.length).toBeGreaterThan(0)
  expect(pedidos.length).toBeLessThan(30)
  for (const url of pedidos) expect(url).toMatch(/^https:\/\/tiles\.e2e\.test\/\d+\/\d+\/\d+\.png$/)
})

test('a timeline de um pedido entregue é completa e a moto não aparece mais', async ({ page }) => {
  const tiles: string[] = []
  page.on('request', (r) => r.url().includes('tiles.e2e.test') && tiles.push(r.url()))
  await page.goto(`${BASE}/pedido/E2E-ENTREGUE`, { waitUntil: 'networkidle' })
  await expect(page.locator('[data-current-status]')).toHaveText('Entregue')
  await expect(page.getByText('o pedido foi entregue')).toBeVisible()
  await expect(page.locator('[data-courier-map], [data-courier-marker], [data-map-fallback], [data-waiting-signal]')).toHaveCount(0)
  expect(tiles).toEqual([])
  expect(await timelineOrder(page)).toEqual(['criado', 'coletado', 'entregue'])
})

test('nenhuma rolagem horizontal em 360 px e nenhum texto fala em horário da ponte', async ({ page }) => {
  await page.route('**/tiles.e2e.test/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }))
  for (const code of ['E2E-SEM-POSICAO', 'E2E-COM-MAPA', 'E2E-BUSCANDO', 'E2E-ENTREGUE']) {
    await page.goto(`${BASE}/pedido/${code}`, { waitUntil: 'networkidle' })
    const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
    expect(w.scroll, code).toBeLessThanOrEqual(w.client)
    const texto = (await page.locator('main').innerText()).toLowerCase()
    expect(texto, code).not.toMatch(/ponte.*(fecha|horário|cerrad)|(fecha|horário).*ponte/)
  }
})

test.describe('radar: procurando motoboy', () => {
  test.use({ reducedMotion: 'no-preference' })

  test('com movimento liberado baixa GSAP e a malha SIMPLIFICADA, nunca os datasets completos', async ({ page }) => {
    const pedidos: string[] = []
    page.on('response', (r) => pedidos.push(r.url()))
    await page.goto(`${BASE}/pedido/E2E-BUSCANDO`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(800)

    await expect(page.locator('[data-searching-radar]')).toBeVisible()
    await expect(page.locator('[role=status]').filter({ hasText: 'Procurando um motoboy' })).toBeVisible()
    expect(pedidos.some((u) => u.endsWith('/data/grid-simplified.json'))).toBe(true)
    expect(pedidos.some((u) => /\/data\/(quarai|artigas)\.json/.test(u))).toBe(false)
    expect(pedidos.some((u) => /gsap/.test(u))).toBe(true)
    expect(pedidos.some((u) => /lenis/.test(u))).toBe(false)
    // a varredura realmente gira: o transform muda com o tempo
    const sweep = page.locator('[data-sweep]')
    const t1 = await sweep.getAttribute('transform')
    await page.waitForTimeout(500)
    const t2 = await sweep.getAttribute('transform')
    expect(t1).not.toBeNull()
    expect(t1).not.toBe(t2)
  })
})

test.describe('radar com prefers-reduced-motion', () => {
  test.use({ reducedMotion: 'reduce' })

  test('o conteúdo está lá e GSAP, Lenis e a malha nem são baixados', async ({ page }) => {
    const pedidos: string[] = []
    page.on('response', (r) => pedidos.push(r.url()))
    await page.goto(`${BASE}/pedido/E2E-BUSCANDO`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(800)

    await expect(page.locator('[role=status]').filter({ hasText: 'Procurando um motoboy' })).toBeVisible()
    await expect(page.locator('[data-searching-radar] svg')).toBeVisible()
    await expect(page.locator('[data-timeline] li')).toHaveCount(2)
    expect(pedidos.filter((u) => /gsap|lenis|\/data\//.test(u))).toEqual([])
    // nada se mexe: a varredura fica sem transform
    expect(await page.locator('[data-sweep]').getAttribute('transform')).toBeNull()
  })
})
