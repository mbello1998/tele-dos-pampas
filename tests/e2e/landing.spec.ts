// @ts-nocheck -- `@playwright/test` ainda não é dependência do projeto (ver playwright.config.ts).
// A mesma lógica foi executada com o Playwright de Python contra o build de produção; o relatório
// da Tarefa 14 registra o resultado. Remova a linha acima quando o pacote for instalado.
import { expect, test } from '@playwright/test'

const rolarAteOFim = async (page) => {
  const altura = await page.evaluate(() => document.documentElement.scrollHeight)
  for (let y = 0; y <= altura; y += 300) {
    await page.evaluate((top) => window.scrollTo(0, top), y)
    await page.waitForTimeout(100)
  }
  await page.waitForTimeout(1200)
}

test.describe('landing em 360 px', () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true })

  test('landing não tem rolagem horizontal em viewport de 360 px', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' })
    const larguras = () => page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
    let w = await larguras()
    expect(w.scroll).toBeLessThanOrEqual(w.client)
    await rolarAteOFim(page) // inclui o desenho da malha e as entradas por rolagem
    w = await larguras()
    expect(w.scroll).toBeLessThanOrEqual(w.client)

    // Margem lateral de 16 px: o texto do hero começa a 16 px da borda.
    const esquerda = await page.locator('h1').evaluate((el) => el.getBoundingClientRect().left)
    expect(esquerda).toBeGreaterThanOrEqual(16)
  })

  test('o dataset de ruas só é buscado quando o leitor rola até a malha', async ({ page }) => {
    const buscados = []
    page.on('response', (r) => r.url().includes('/data/') && buscados.push(r.url()))
    await page.goto('/', { waitUntil: 'networkidle' })
    expect(buscados).toEqual([])
    await rolarAteOFim(page)
    expect(buscados.some((u) => u.endsWith('/data/quarai.json'))).toBe(true)
    expect(buscados.some((u) => u.endsWith('/data/artigas.json'))).toBe(true)
  })
})

test.describe('prefers-reduced-motion', () => {
  test.use({ reducedMotion: 'reduce', viewport: { width: 1280, height: 800 } })

  test('mantém o conteúdo visível e não baixa GSAP, Lenis nem o dataset', async ({ page }) => {
    const pedidos = []
    page.on('response', (r) => pedidos.push(r.url()))
    await page.goto('/', { waitUntil: 'networkidle' })
    await rolarAteOFim(page)

    await expect(page.locator('h1')).toBeVisible()
    for (const el of await page.locator('h1 .palavra').all()) {
      expect(await el.evaluate((n) => getComputedStyle(n).opacity)).toBe('1')
    }
    await expect(page.locator('#como-funciona li')).toHaveCount(3)
    for (const li of await page.locator('#como-funciona li').all()) {
      expect(await li.evaluate((n) => getComputedStyle(n).opacity)).toBe('1')
    }

    expect(await page.evaluate(() => document.documentElement.classList.contains('lenis'))).toBe(false)
    expect(pedidos.filter((u) => /gsap|lenis|\/data\//.test(u))).toEqual([])
  })
})

test.describe('movimento liberado, desktop', () => {
  test.use({ reducedMotion: 'no-preference', viewport: { width: 1280, height: 800 } })

  test('Lenis entra por import dinâmico só com movimento liberado e ponteiro fino', async ({ page }) => {
    const pedidos = []
    page.on('response', (r) => pedidos.push(r.url()))
    await page.goto('/', { waitUntil: 'networkidle' })
    await page.waitForTimeout(800)
    expect(pedidos.some((u) => /lenis/.test(u))).toBe(true)
    expect(await page.evaluate(() => document.documentElement.classList.contains('lenis'))).toBe(true)
  })
})

test('a versão em espanhol usa os textos es-UY das mesmas chaves de settings', async ({ page }) => {
  await page.goto('/es', { waitUntil: 'networkidle' })
  await expect(page.locator('[lang="es-UY"]').first()).toBeVisible()
  await expect(page.locator('h1')).not.toHaveText(/Tele-entrega/)
})
