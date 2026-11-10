import { gzipSync } from 'node:zlib'
import { expect, type Page, test } from '@playwright/test'

const ORCAMENTO = 180_000 // bytes comprimidos de JS na rota inicial

/** Soma o JS que o navegador realmente recebeu, comprimido com gzip no maior nível. */
type ArquivoJs = { url: string; gz: number }

function coletarJs(page: Page): ArquivoJs[] {
  const arquivos: ArquivoJs[] = []
  page.on('response', async (r) => {
    if (!/\.js(\?|$)/.test(r.url())) return
    try {
      arquivos.push({ url: r.url(), gz: gzipSync(await r.body(), { level: 9 }).length })
    } catch {
      // resposta sem corpo (redirecionamento, cache): não conta
    }
  })
  return arquivos
}
const total = (arquivos: ArquivoJs[]) => arquivos.reduce((n, a) => n + a.gz, 0)

async function rolarAteOFim(page: Page) {
  const altura = await page.evaluate(() => document.documentElement.scrollHeight)
  for (let y = 0; y <= altura; y += 300) {
    await page.evaluate((top) => window.scrollTo(0, top), y)
    await page.waitForTimeout(100)
  }
  await page.waitForTimeout(1500)
}

test.describe('orçamento de desempenho', () => {
  test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true })

  test('JS da rota inicial fica abaixo de 180 kB comprimido', async ({ page }) => {
    const js = coletarJs(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    await rolarAteOFim(page) // pior caso: com movimento liberado, GSAP e ScrollTrigger já baixados
    // Garante que este é mesmo o pior caso: com movimento liberado o GSAP foi baixado.
    expect(js.some((a) => /gsap/.test(a.url))).toBe(true)
    expect(total(js), JSON.stringify(js)).toBeLessThan(ORCAMENTO)
  })

  test('nenhum script de WebGL ou three.js, e nenhum canvas na página', async ({ page }) => {
    const js = coletarJs(page)
    const pedidos: string[] = []
    page.on('request', (r) => pedidos.push(r.url()))
    await page.goto('/', { waitUntil: 'networkidle' })
    await rolarAteOFim(page)
    expect(pedidos.filter((u) => /three|webgl|ogl|pixi/i.test(u))).toEqual([])
    expect(await page.locator('canvas').count()).toBe(0)
    const usaWebGL = await page.evaluate(() => /WebGLRenderer|WebGL2RenderingContext/.test(document.documentElement.outerHTML))
    expect(usaWebGL).toBe(false)
    expect(js.length).toBeGreaterThan(0)
  })
})

test.describe('com reduced-motion o JS é só o do Next', () => {
  test.use({ reducedMotion: 'reduce', viewport: { width: 360, height: 740 } })

  test('abaixo de 180 kB, sem GSAP', async ({ page }) => {
    const js = coletarJs(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    await rolarAteOFim(page)
    expect(total(js)).toBeLessThan(ORCAMENTO)
    expect(js.filter((a) => /gsap|lenis/.test(a.url))).toEqual([])
  })
})
