import { expect, type Page, type Response, test } from '@playwright/test'
import { convertBrlToUyu } from '../../src/lib/money/format'
import { cleanupUsers, createUser, setProfile, signInViaUi, withDb, type TestUser } from './auth-helpers'

// Catálogo e carrinho no navegador real, contra o build de produção e o banco compartilhado.
//
// SOMENTE LEITURA do catálogo: lê as duas lojas de demonstração semeadas (supabase/seed.sql). Este spec nunca
// insere nem apaga loja, item ou horário. A única escrita é o usuário de teste (criado e removido pelos helpers de
// auth) e a moeda preferida DELE, que o teste liga e desliga.
//
//   Trailer do Zé (Quaraí)            06:00-00:00 todos os dias (atravessa a meia-noite)
//   Restaurante La Frontera (Artigas) 08:00-23:00 todos os dias
//
// O horário de agora decide o que se espera de cada loja: o relógio do servidor não se finge de dentro do teste.
// Testes que precisam de loja aberta (ou fechada) são pulados com motivo quando a hora não permite, em vez de
// passarem por acaso. O caso "fechada" é coberto por testes unitários, e aqui só quando uma loja está fechada.
const TRAILER = '00000000-0000-4000-8000-000000000001'
const RESTAURANTE = '00000000-0000-4000-8000-000000000002'

// Hora local (UTC-3, as duas cidades) de agora, independente do fuso da máquina.
const horaLocal = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Montevideo', hour: '2-digit', hourCycle: 'h23' }).format(new Date()))
// Margem de 2 min nas viradas de horário: um teste que roda na virada não pode afirmar nada.
const naBorda = () => {
  const m = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Montevideo', minute: '2-digit' }).format(new Date()))
  return m >= 58 || m <= 1
}
const trailerAberto = () => horaLocal() >= 6 // 06:00 a 00:00
const restauranteAberto = () => horaLocal() >= 8 && horaLocal() < 23 // 08:00 a 23:00

let cliente: TestUser
let page: Page

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true })

test.beforeAll(async ({ browser }) => {
  cliente = await createUser('catalogo')
  await setProfile(cliente.id, { full_name: 'Cliente Catalogo' })
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true })
  page = await ctx.newPage()
  await signInViaUi(page, cliente, { next: '/lojas' })
  await page.waitForURL('**/lojas')
})

test.afterAll(async () => {
  await cleanupUsers()
})

const artigo = (nome: string) => page.locator('article', { hasText: nome })
const adicionar = (nome: string) => artigo(nome).locator('[data-action="add"]')
const subtotal = () => page.getByTestId('cart-subtotal')
const abrirTrailer = async () => {
  await page.goto(`/lojas/${TRAILER}`)
  await page.evaluate(() => sessionStorage.clear())
  await page.reload()
}

test('sem sessão, /lojas manda para o login', async ({ browser }) => {
  const ctx = await browser.newContext()
  const anon = await ctx.newPage()
  await anon.goto('/lojas')
  await expect(anon).toHaveURL(/\/entrar\?next=%2Flojas/)
  await ctx.close()
})

test('a listagem mostra cada loja aberta ou fechada conforme o horário de agora', async () => {
  test.skip(naBorda(), 'virada de horário: o estado esperado é ambíguo neste minuto')
  await page.goto('/lojas')
  const card = (nome: string) => page.locator('a[data-open]', { hasText: nome })
  await expect(card('Trailer do Zé')).toHaveAttribute('data-open', String(trailerAberto()))
  await expect(card('Trailer do Zé')).toContainText(trailerAberto() ? 'Aberta' : 'Fechada')
  await expect(card('La Frontera')).toHaveAttribute('data-open', String(restauranteAberto()))
  await expect(card('La Frontera')).toContainText(restauranteAberto() ? 'Aberta' : 'Fechada')
})

test('a comissão da loja não aparece em nenhuma resposta ao cliente', async () => {
  const respostas: string[] = []
  const vigia = async (r: Response) => {
    const tipo = r.headers()['content-type'] ?? ''
    if (r.url().includes('localhost') && (tipo.includes('text/html') || tipo.includes('text/x-component'))) respostas.push(await r.text().catch(() => ''))
  }
  page.on('response', vigia)
  await page.goto('/lojas')
  await page.goto(`/lojas/${TRAILER}`)
  await page.waitForLoadState('networkidle')
  page.off('response', vigia)
  const tudo = respostas.join('\n').toLowerCase()
  expect(tudo).toContain('xis de coração') // a captura funcionou
  expect(tudo).not.toContain('commission')
  expect(tudo).not.toContain('comiss')
})

test('id de loja malformado ou inexistente dá 404', async () => {
  expect((await page.goto('/lojas/nao-e-uuid'))!.status()).toBe(404)
  expect((await page.goto('/lojas/00000000-0000-4000-8000-0000000000ff'))!.status()).toBe(404)
})

test('o cardápio mostra categorias e preços em reais, com as opções do item', async () => {
  await abrirTrailer()
  await expect(artigo('Xis salada').locator('.preco').first()).toHaveText('R$ 28,00')
  await expect(artigo('Coca-Cola lata').locator('.preco').first()).toHaveText('R$ 7,00')
  const xis = artigo('Xis de coração')
  await expect(xis.locator('.preco').first()).toHaveText('R$ 32,00')
  await expect(xis.getByText('Ponto da carne', { exact: true })).toBeVisible()
  await expect(xis.getByText('Obrigatório', { exact: true })).toBeVisible()
  await expect(xis.getByRole('checkbox', { name: /^Bacon.*4,00$/ })).toBeVisible()
})

test('ponto da carne é escolha única: trocar substitui, não soma', async () => {
  test.skip(!trailerAberto() || naBorda(), 'o trailer está fechado agora')
  await abrirTrailer()
  const xis = artigo('Xis de coração')
  await xis.getByRole('radio', { name: /^Ao ponto/ }).check()
  await xis.getByRole('radio', { name: /^Bem passado/ }).check()
  await expect(xis.getByRole('radio', { name: /^Ao ponto/ })).not.toBeChecked()
  await expect(xis.getByRole('radio', { name: /^Bem passado/ })).toBeChecked()
})

test('grupo obrigatório trava o botão até escolher o ponto; o subtotal soma base mais deltas', async () => {
  test.skip(!trailerAberto() || naBorda(), 'o trailer está fechado agora: não dá para adicionar')
  await abrirTrailer()
  await expect(adicionar('Xis de coração')).toBeDisabled()
  await expect(artigo('Xis de coração')).toContainText('Escolha: Ponto da carne')

  await artigo('Xis de coração').getByRole('radio', { name: /^Ao ponto/ }).check()
  await expect(adicionar('Xis de coração')).toBeEnabled()
  await artigo('Xis de coração').getByRole('checkbox', { name: /^Bacon/ }).check()
  await artigo('Xis de coração').getByRole('checkbox', { name: /^Ovo/ }).check()

  await adicionar('Xis de coração').click()
  // 32,00 + 0,00 (ao ponto) + 4,00 (bacon) + 3,00 (ovo) = 39,00
  await expect(subtotal()).toContainText('R$ 39,00')
})

test('o carrinho sobrevive a recarregar a página (sessionStorage)', async () => {
  test.skip(!trailerAberto() || naBorda(), 'o trailer está fechado agora')
  await page.reload()
  await expect(subtotal()).toContainText('R$ 39,00')
})

test('quantidade muda o subtotal e remover esvazia o carrinho', async () => {
  test.skip(!trailerAberto() || naBorda(), 'o trailer está fechado agora')
  await page.reload()
  await page.getByRole('button', { name: 'Mais um' }).click()
  await expect(subtotal()).toContainText('R$ 78,00')
  await page.getByRole('button', { name: 'Remover' }).click()
  await expect(page.getByText('Seu carrinho está vazio.')).toBeVisible()
})

test('o carrinho só aceita um merchant: trocar de loja pede confirmação e só então esvazia', async () => {
  test.skip(!trailerAberto() || !restauranteAberto() || naBorda(), 'as duas lojas precisam estar abertas')
  await abrirTrailer()
  await adicionar('Água mineral').click()
  await expect(subtotal()).toContainText('R$ 4,00')

  await page.goto(`/lojas/${RESTAURANTE}`)
  await adicionar('Agua mineral').click()
  const dialogo = page.getByRole('alertdialog')
  await expect(dialogo).toContainText('Trocar de loja?')
  await dialogo.getByRole('button', { name: 'Manter meu carrinho' }).click()
  await expect(dialogo).toHaveCount(0)
  await expect(page.getByText(/Pedido de Trailer do Zé/)).toBeVisible() // o carrinho antigo continua

  await adicionar('Agua mineral').click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Esvaziar e adicionar' }).click()
  await expect(page.getByText(/Pedido de Restaurante La Frontera/)).toBeVisible()
  await expect(subtotal()).toContainText('R$ 5,00')
  await page.getByRole('button', { name: 'Remover' }).click()
})

test('loja fechada agora não deixa adicionar (só roda quando alguma loja está fechada)', async () => {
  const fechada = !restauranteAberto() ? RESTAURANTE : !trailerAberto() ? TRAILER : null
  test.skip(fechada === null || naBorda(), 'as duas lojas estão abertas agora; o caso fechado é coberto pelos testes unitários')
  await page.goto(`/lojas/${fechada}`)
  await expect(page.locator('header [data-open]')).toHaveAttribute('data-open', 'false')
  const botoes = page.locator('[data-action="add"]')
  expect(await botoes.count()).toBeGreaterThan(0)
  for (let i = 0; i < (await botoes.count()); i++) await expect(botoes.nth(i)).toBeDisabled()
  await expect(page.locator('article').first()).toContainText('Loja fechada')
})

test('em pesos, o preço de vitrine é o convertido com teto, o aviso de cotação defasada aparece e todo valor usa .preco', async () => {
  await withDb(async (q) => void (await q(`update public.profiles set currency_pref = 'UYU' where id = $1`, [cliente.id])))
  try {
    await page.goto(`/lojas/${TRAILER}`)
    // A taxa que a página usou, lida do mesmo jeito (a do dia; senão a última gravada; senão 7,80 e aviso).
    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(new Date())
    const taxa = await withDb(async (q) => {
      const r = await q(
        `select rate::float8 as rate, spread_pct::float8 as spread, valid_for_date::text as dia from public.fx_rates where pair = 'BRL/UYU'
         order by (valid_for_date = $1::date) desc, valid_for_date desc, is_manual_override desc, fetched_at desc, id limit 1`,
        [hoje],
      )
      return r[0] ? { rate: Number(r[0].rate), spreadPct: Number(r[0].spread), dia: String(r[0].dia) } : { rate: 7.8, spreadPct: 0, dia: null }
    })
    const esperado = (brl: number) => `$U ${convertBrlToUyu(brl, taxa.rate, taxa.spreadPct).toLocaleString('es-UY')}`
    await expect(artigo('Xis salada').locator('.preco').first()).toHaveText(esperado(28))
    await expect(artigo('Xis de coração').locator('.preco').first()).toHaveText(esperado(32))
    // 7,00 BRL nunca vira menos pesos do que a conversão com teto
    await expect(artigo('Coca-Cola lata').locator('.preco').first()).toHaveText(esperado(7))

    // Cotação defasada é dita: com a do dia não há aviso; senão há, com a data ou como "aproximada".
    const aviso = page.locator('[data-fx-note]')
    if (taxa.dia === hoje) await expect(aviso).toHaveCount(0)
    else await expect(aviso.first()).toBeVisible()

    // Todo texto com R$ ou $U está dentro de um elemento .preco.
    const fora = await page.evaluate(() => {
      const re = /(R\$|\$U) ?-?[\d.,]+/
      const ruins: string[] = []
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (re.test(n.textContent ?? '') && !n.parentElement?.closest('.preco')) ruins.push((n.textContent ?? '').trim())
      }
      return ruins
    })
    expect(fora).toEqual([])
  } finally {
    await withDb(async (q) => void (await q(`update public.profiles set currency_pref = 'BRL' where id = $1`, [cliente.id])))
  }
})

test('as duas telas cabem em 360 px sem rolagem lateral', async () => {
  for (const url of ['/lojas', `/lojas/${TRAILER}`]) {
    await page.goto(url)
    const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
    expect(w.scroll).toBeLessThanOrEqual(w.client)
  }
})
