import { expect, type Page, type Response, test } from '@playwright/test'

// Seletor de endereço no navegador real, contra o build de produção. O que só um navegador prova:
// o dataset (cerca de 600 kB) e o Leaflet não vêm no carregamento da página, só sob demanda, e o
// fluxo cabe em 360 px sem rolagem lateral.
//
// Os chunks são identificados pelo CONTEÚDO, não pelo nome: o Next dá nomes com hash.
//   - dataset: contém "Puente de la Concordia" (única rua presente nos dois arquivos);
//   - Leaflet: contém "leaflet-container" (classe que ele mesmo grava, no JS e no CSS).
const URL_PAGINA = '/enderecos/novo'
const TILES = 'https://tiles.exemplo.test/{z}/{x}/{y}.png'
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

type Chunk = { url: string; dataset: boolean; leaflet: boolean }

/** Registra o conteúdo de todo JS/CSS do Next que a página baixar. `settled()` espera as leituras terminarem. */
function vigiarChunks(page: Page) {
  const chunks: Chunk[] = []
  const pendentes: Promise<void>[] = []
  page.on('response', (r: Response) => {
    const url = r.url()
    if (!/\/_next\/static\/.*\.(js|css)(\?|$)/.test(url)) return
    pendentes.push(
      r
        .text()
        .then((t) => void chunks.push({ url, dataset: t.includes('Puente de la Concordia'), leaflet: t.includes('leaflet-container') }))
        .catch(() => undefined),
    )
  })
  return { chunks, settled: () => Promise.all(pendentes).then(() => undefined) }
}

/** O formulário lê a URL dos tiles de settings['map.tile_url']; aqui a resposta é fixada para o teste. */
async function simularTiles(page: Page) {
  const pedidosDeTile: string[] = []
  await page.route('**/rest/v1/settings**', (route) => route.fulfill({ json: [{ value: TILES }] }))
  await page.route('https://tiles.exemplo.test/**', (route) => {
    pedidosDeTile.push(route.request().url())
    return route.fulfill({ contentType: 'image/png', body: PNG_1X1 })
  })
  return pedidosDeTile
}

const rua = (page: Page) => page.getByRole('combobox')
async function escolherRua(page: Page, busca: string, opcao: RegExp) {
  await rua(page).fill(busca)
  await page.getByRole('option', { name: opcao }).first().click()
}

test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true })

test('dataset e Leaflet só são baixados sob demanda: foco na rua traz o dataset, o pino traz o Leaflet', async ({ page }) => {
  const vigia = vigiarChunks(page)
  await simularTiles(page)
  await page.goto(URL_PAGINA, { waitUntil: 'networkidle' })
  await vigia.settled()
  expect(vigia.chunks.length).toBeGreaterThan(0) // o vigia está de fato enxergando os chunks
  expect(vigia.chunks.filter((c) => c.dataset).map((c) => c.url), 'dataset no carregamento inicial').toEqual([])
  expect(vigia.chunks.filter((c) => c.leaflet).map((c) => c.url), 'Leaflet no carregamento inicial').toEqual([])

  await rua(page).focus()
  await expect.poll(async () => (await vigia.settled(), vigia.chunks.some((c) => c.dataset))).toBe(true)
  expect(vigia.chunks.some((c) => c.leaflet), 'Leaflet veio junto com o dataset').toBe(false)

  await escolherRua(page, 'puente de la concordia', /Brasil/)
  await page.getByRole('radio').first().check()
  expect(vigia.chunks.some((c) => c.leaflet), 'Leaflet antes de pedir o mapa').toBe(false)

  await page.getByRole('button', { name: /marcar no mapa/i }).click()
  await expect(page.locator('.leaflet-container')).toBeVisible()
  await vigia.settled()
  expect(vigia.chunks.some((c) => c.leaflet)).toBe(true)
})

test('a lista de rua rotula cidade e país, e a ponte exige escolher o lado', async ({ page }) => {
  await page.goto(URL_PAGINA, { waitUntil: 'networkidle' })
  await rua(page).fill('puente de la concordia')
  const opcoes = page.getByRole('option')
  await expect(opcoes).toHaveCount(2)
  await expect(opcoes.filter({ hasText: 'Artigas' })).toContainText('Uruguai')
  await expect(opcoes.filter({ hasText: 'Quaraí' })).toContainText('Brasil')
  await expect(page.getByRole('radio')).toHaveCount(0) // nada foi escolhido sozinho
  await expect(page.getByRole('button', { name: /salvar endereço/i })).toBeDisabled()

  await opcoes.filter({ hasText: 'Brasil' }).click()
  await expect(page.getByRole('radio').first()).toBeVisible()
  await expect(page.getByText(/Canabarro/)).toBeVisible() // esquina da ponte do lado brasileiro
})

test('o mapa usa a URL de tiles das settings e nasce na quadra; tocar nele marca o ponto', async ({ page }) => {
  const tiles = await simularTiles(page)
  await page.goto(URL_PAGINA, { waitUntil: 'networkidle' })
  await escolherRua(page, 'ibirapita', /Escuela 65/)
  await page.getByRole('radio').first().check()
  await page.getByRole('button', { name: /marcar no mapa/i }).click()
  await expect(page.locator('.leaflet-container')).toBeVisible()
  await expect.poll(() => tiles.length).toBeGreaterThan(0) // os tiles saíram da URL configurada, não de uma fixa
  await expect(page.locator('.leaflet-marker-draggable')).toHaveCount(1)

  await page.locator('.leaflet-container').click({ position: { x: 60, y: 60 } })
  await expect(page.getByText('Ponto marcado.')).toBeVisible()
})

test('sem tiles disponíveis o mapa avisa e o formulário continua utilizável', async ({ page }) => {
  await page.route('**/rest/v1/settings**', (route) => route.fulfill({ json: [] })) // linha ausente
  await page.goto(URL_PAGINA, { waitUntil: 'networkidle' })
  await escolherRua(page, 'ibirapita', /Escuela 65/)
  await page.getByRole('radio').first().check()
  await page.getByRole('button', { name: /marcar no mapa/i }).click()
  await expect(page.getByText(/mapa está indisponível/i)).toBeVisible()
  await expect(page.locator('.leaflet-container')).toHaveCount(0)
  await page.getByLabel(/ponto de referência/i).fill('portão azul')
  await expect(page.getByRole('button', { name: /salvar endereço/i })).toBeEnabled()
})

test('localização negada explica e deixa seguir pela quadra', async ({ page, context }) => {
  await context.clearPermissions()
  await page.goto(URL_PAGINA, { waitUntil: 'networkidle' })
  await escolherRua(page, 'ibirapita', /Escuela 65/)
  await page.getByRole('button', { name: /usar minha localização/i }).click()
  await expect(page.getByRole('status').filter({ hasText: /permissão|disponível|tempo/i })).toBeVisible()
  await page.getByRole('radio').first().check()
  await page.getByLabel(/ponto de referência/i).fill('portão azul')
  await expect(page.getByRole('button', { name: /salvar endereço/i })).toBeEnabled()
})

test('localização longe da rua escolhida é recusada; perto dela vira ponto marcado', async ({ page, context }) => {
  await context.grantPermissions(['geolocation'])
  await page.goto(URL_PAGINA, { waitUntil: 'networkidle' })
  await escolherRua(page, 'ibirapita', /Escuela 65/)

  await context.setGeolocation({ latitude: -34.9, longitude: -56.16, accuracy: 20 }) // Montevidéu
  await page.getByRole('button', { name: /usar minha localização/i }).click()
  await expect(page.getByText(/longe da rua/i)).toBeVisible()
  await expect(page.getByText('Ponto marcado.')).toHaveCount(0)

  await context.setGeolocation({ latitude: -30.40107, longitude: -56.49277, accuracy: 15 }) // sobre Ibirapitá, entre Ute 38 e Francisca Rodríguez Pascual
  await page.getByRole('button', { name: /usar minha localização/i }).click()
  await expect(page.getByText('Ponto marcado.')).toBeVisible()
})

test('salvar exige a referência e, preenchida, chega à Server Action (que recusa quem não entrou)', async ({ page }) => {
  const acoes: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.headers()['next-action']) acoes.push(r.url())
  })
  await page.goto(URL_PAGINA, { waitUntil: 'networkidle' })
  await escolherRua(page, 'ibirapita', /Escuela 65/)
  await page.getByRole('radio').first().check()

  await page.getByRole('button', { name: /salvar endereço/i }).click()
  await expect(page.getByRole('alert')).toContainText(/escreva uma referência/i)
  expect(acoes).toEqual([]) // nem saiu do navegador

  await page.getByLabel(/ponto de referência/i).fill('casa verde, do lado do posto')
  await page.getByRole('button', { name: /salvar endereço/i }).click()
  await expect.poll(() => acoes.length).toBe(1)
  await expect(page.getByText(/não foi possível salvar/i)).toBeVisible()
  await expect(page.getByLabel(/ponto de referência/i)).toHaveValue('casa verde, do lado do posto') // nada se perde
})

test('em 360 px não há rolagem lateral e os alvos de toque têm 44 px', async ({ page }) => {
  await simularTiles(page)
  await page.goto(URL_PAGINA, { waitUntil: 'networkidle' })
  const largura = () =>
    page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))

  await rua(page).fill('avenida')
  await expect(page.getByRole('option').first()).toBeVisible()
  let w = await largura()
  expect(w.scroll).toBeLessThanOrEqual(w.client)

  await page.getByRole('option').first().click()
  await page.getByRole('button', { name: /marcar no mapa/i }).click()
  await expect(page.locator('.leaflet-container')).toBeVisible()
  w = await largura()
  expect(w.scroll).toBeLessThanOrEqual(w.client)

  for (const alvo of await page.locator('button:visible, input:visible, textarea:visible').all()) {
    const box = await alvo.boundingBox()
    if (!box) continue
    const tipo = await alvo.getAttribute('type')
    if (tipo === 'radio') continue // o toque vai no rótulo inteiro, que tem 44 px
    expect(box.height, await alvo.evaluate((n) => n.outerHTML.slice(0, 80))).toBeGreaterThanOrEqual(43.5)
  }
  for (const rotulo of await page.locator('fieldset label').all()) {
    expect((await rotulo.boundingBox())!.height).toBeGreaterThanOrEqual(43.5)
  }
})
