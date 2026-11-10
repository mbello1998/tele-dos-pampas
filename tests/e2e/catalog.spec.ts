import { expect, type Page, test } from '@playwright/test'
import { convertBrlToUyu } from '../../src/lib/money/format'
import { cleanupUsers, createUser, setProfile, signInViaUi, withDb, type TestUser } from './auth-helpers'

// Catálogo e carrinho no navegador real, contra o build de produção e o banco compartilhado.
//
// DADOS: este spec cria as próprias lojas (aprovadas, sem dono) e itens, e REMOVE tudo no fim, inclusive as linhas
// de audit_log que as tabelas auditadas geraram. Nada fica no banco. As lojas existem por segundos e são visíveis a
// qualquer cliente nesse intervalo; por isso o nome leva um marcador único.
//
// A comissão de cada loja é um valor reconhecível (12,34) para provar que ele nunca chega ao HTML.
const TAG = `e2e${Date.now().toString(36)}`
const COMISSAO = '12.34'

type Ids = { merchants: Record<'A' | 'B' | 'manualOff' | 'foraDoHorario', string>; byTable: Record<string, string[]> }
let ids: Ids
let cliente: TestUser
let page: Page

const nome = (s: string) => `${s} ${TAG}`

// Dia da semana (0 = domingo) de agora no relógio de Quaraí/Artigas.
const hoje = () =>
  ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Montevideo', weekday: 'short' }).format(new Date()) as 'Sun'
  ]

async function semear(): Promise<Ids> {
  const byTable: Record<string, string[]> = { merchants: [], catalog_categories: [], catalog_items: [], item_option_groups: [], item_options: [], merchant_hours: [] }
  const out = await withDb(async (q) => {
    const ins = async (table: string, sql: string, params: unknown[]) => {
      const id = String((await q(sql + ' returning id', params))[0].id)
      byTable[table].push(id)
      return id
    }
    const loja = (n: string, city: string, country: string, manual: boolean) =>
      ins(
        'merchants',
        `insert into public.merchants (name, kind, city, country, address_text, prep_time_min, commission_pct, is_open_manual, accepts_cross_border, status)
         values ($1, 'trailer', $2, $3, 'Rua de teste', 15, ${COMISSAO}, $4, true, 'approved')`,
        [nome(n), city, country, manual],
      )
    const horas24 = async (m: string) => {
      for (let d = 0; d < 7; d++) await ins('merchant_hours', `insert into public.merchant_hours (merchant_id, weekday, opens_at, closes_at) values ($1, $2, '00:00', '00:00')`, [m, d])
    }
    const A = await loja('E2E Aberta A', 'quarai', 'BR', true)
    const B = await loja('E2E Aberta B', 'artigas', 'UY', true)
    const manualOff = await loja('E2E Manual desligado', 'quarai', 'BR', false)
    const foraDoHorario = await loja('E2E Fora do horario', 'quarai', 'BR', true)
    await horas24(A)
    await horas24(B)
    await horas24(manualOff) // dentro do horário, mas a chave manual está desligada
    await ins('merchant_hours', `insert into public.merchant_hours (merchant_id, weekday, opens_at, closes_at) values ($1, $2, '00:00', '00:00')`, [foraDoHorario, (hoje() + 3) % 7]) // só abre em outro dia

    const item = async (m: string, cat: string | null, n: string, preco: number) =>
      ins('catalog_items', `insert into public.catalog_items (merchant_id, category_id, name, price_brl, sort_order) values ($1, $2, $3, $4, 0)`, [m, cat, n, preco])
    const catA = await ins('catalog_categories', `insert into public.catalog_categories (merchant_id, name, sort_order) values ($1, 'Lanches', 0)`, [A])
    const lanche = await item(A, catA, 'Lanche E2E', 19.9)
    await item(A, catA, 'Agua E2E', 5)
    const tam = await ins('item_option_groups', `insert into public.item_option_groups (item_id, name, min_select, max_select, is_required) values ($1, 'Tamanho', 1, 1, true)`, [lanche])
    await ins('item_options', `insert into public.item_options (group_id, name, price_delta_brl) values ($1, 'P', 0)`, [tam])
    await ins('item_options', `insert into public.item_options (group_id, name, price_delta_brl) values ($1, 'G', 4.10)`, [tam])
    const ext = await ins('item_option_groups', `insert into public.item_option_groups (item_id, name, min_select, max_select, is_required) values ($1, 'Extras', 0, 2, false)`, [lanche])
    for (const [n, d] of [['Bacon', 2.5], ['Ovo', 1.1], ['Queijo', 3]] as const) await ins('item_options', `insert into public.item_options (group_id, name, price_delta_brl) values ($1, $2, $3)`, [ext, n, d])
    await item(B, null, 'Mate E2E', 7)
    await item(manualOff, null, 'Agua fechada E2E', 5)
    await item(foraDoHorario, null, 'Agua fora E2E', 5)
    return { A, B, manualOff, foraDoHorario }
  })
  return { merchants: out, byTable }
}

async function limpar(i: Ids | undefined) {
  if (!i) return
  await withDb(async (q) => {
    await q(`delete from public.merchants where id = any($1::uuid[])`, [i.merchants && Object.values(i.merchants)]) // cascata: categorias, itens, grupos, opções, horários
    for (const [table, list] of Object.entries(i.byTable)) {
      if (list.length) await q(`delete from public.audit_log where table_name = $1 and record_id = any($2::text[])`, [table, list])
    }
  })
}

const taxaVigente = () =>
  withDb(async (q) => {
    const hojeData = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montevideo' }).format(new Date())
    const rows = await q(
      `select rate::float8 as rate, spread_pct::float8 as spread from public.fx_rates where pair = 'BRL/UYU'
       order by (valid_for_date = $1::date) desc, valid_for_date desc, is_manual_override desc, fetched_at desc, id limit 1`,
      [hojeData],
    )
    return rows[0] ? { rate: Number(rows[0].rate), spreadPct: Number(rows[0].spread) } : { rate: 7.8, spreadPct: 0 }
  })

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true })

test.beforeAll(async ({ browser }) => {
  ids = await semear()
  cliente = await createUser('catalogo')
  await setProfile(cliente.id, { full_name: 'Cliente Catalogo' })
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true })
  page = await ctx.newPage()
  await signInViaUi(page, cliente, { next: '/lojas' })
  await page.waitForURL('**/lojas')
})

test.afterAll(async () => {
  await limpar(ids)
  await cleanupUsers()
})

const artigo = (nomeItem: string) => page.locator('article', { hasText: nomeItem })
const adicionar = (nomeItem: string) => artigo(nomeItem).locator('[data-action="add"]')
const subtotal = () => page.getByTestId('cart-subtotal')
const lojaUrl = (k: keyof Ids['merchants']) => `/lojas/${ids.merchants[k]}`

test('sem sessão, /lojas manda para o login', async ({ browser }) => {
  const ctx = await browser.newContext()
  const anon = await ctx.newPage()
  await anon.goto('/lojas')
  await expect(anon).toHaveURL(/\/entrar\?next=%2Flojas/)
  await ctx.close()
})

test('a listagem mostra as lojas abertas e fecha as que estão fora do horário ou com a chave manual desligada', async () => {
  await page.goto('/lojas')
  const card = (n: string) => page.locator('a[data-open]', { hasText: nome(n) })
  await expect(card('E2E Aberta A')).toHaveAttribute('data-open', 'true')
  await expect(card('E2E Aberta A')).toContainText('Aberta')
  await expect(card('E2E Aberta B')).toHaveAttribute('data-open', 'true')
  await expect(card('E2E Fora do horario')).toHaveAttribute('data-open', 'false')
  await expect(card('E2E Fora do horario')).toContainText('Fechada')
  // 24 horas por dia, mas o dono apertou o botão: fechada mesmo dentro do horário
  await expect(card('E2E Manual desligado')).toHaveAttribute('data-open', 'false')
})

test('a comissão da loja não aparece em nenhuma resposta ao cliente', async () => {
  const respostas: string[] = []
  const vigia = async (r: import('@playwright/test').Response) => {
    const tipo = r.headers()['content-type'] ?? ''
    if (r.url().includes('localhost') && tipo.includes('text/html') || tipo.includes('text/x-component')) respostas.push(await r.text().catch(() => ''))
  }
  page.on('response', vigia)
  await page.goto('/lojas')
  await page.goto(lojaUrl('A'))
  await page.waitForLoadState('networkidle')
  page.off('response', vigia)
  const tudo = respostas.join('\n')
  expect(tudo).toContain('Lanche E2E') // a captura funcionou
  expect(tudo).not.toContain(COMISSAO)
  expect(tudo.toLowerCase()).not.toContain('commission')
  expect(tudo.toLowerCase()).not.toContain('comiss')
})

test('id de loja malformado ou inexistente dá 404', async () => {
  expect((await page.goto('/lojas/nao-e-uuid'))!.status()).toBe(404)
  expect((await page.goto('/lojas/00000000-0000-4000-8000-0000000000ff'))!.status()).toBe(404)
})

test('grupo obrigatório trava o botão até escolher o tamanho; o subtotal soma base mais deltas', async () => {
  await page.goto(lojaUrl('A'))
  await page.evaluate(() => sessionStorage.clear())
  await page.reload()
  await expect(adicionar('Lanche E2E')).toBeDisabled()
  await expect(artigo('Lanche E2E')).toContainText('Escolha: Tamanho')

  await artigo('Lanche E2E').getByRole('radio', { name: /^G/ }).check()
  await expect(adicionar('Lanche E2E')).toBeEnabled()
  await artigo('Lanche E2E').getByRole('checkbox', { name: /^Bacon/ }).check()
  await artigo('Lanche E2E').getByRole('checkbox', { name: /^Ovo/ }).check()
  // máximo de 2 extras: o terceiro fica desabilitado
  await expect(artigo('Lanche E2E').getByRole('checkbox', { name: /^Queijo/ })).toBeDisabled()

  await adicionar('Lanche E2E').click()
  // 19,90 + 4,10 (G) + 2,50 (bacon) + 1,10 (ovo) = 27,60
  await expect(subtotal()).toContainText('R$ 27,60')
})

test('o carrinho sobrevive a recarregar a página (sessionStorage)', async () => {
  await page.reload()
  await expect(subtotal()).toContainText('R$ 27,60')
})

test('quantidade muda o subtotal e remover esvazia o carrinho', async () => {
  await page.getByRole('button', { name: 'Mais um' }).click()
  await expect(subtotal()).toContainText('R$ 55,20')
  await page.getByRole('button', { name: 'Remover' }).click()
  await expect(page.getByText('Seu carrinho está vazio.')).toBeVisible()
})

test('o carrinho só aceita um merchant: trocar de loja pede confirmação e só então esvazia', async () => {
  await page.goto(lojaUrl('A'))
  await adicionar('Agua E2E').click()
  await expect(subtotal()).toContainText('R$ 5,00')

  await page.goto(lojaUrl('B'))
  await adicionar('Mate E2E').click()
  const dialogo = page.getByRole('alertdialog')
  await expect(dialogo).toContainText('Trocar de loja?')
  await dialogo.getByRole('button', { name: 'Manter meu carrinho' }).click()
  await expect(dialogo).toHaveCount(0)
  await expect(page.getByText('Pedido de ' + nome('E2E Aberta A'))).toBeVisible() // o carrinho antigo continua

  await adicionar('Mate E2E').click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Esvaziar e adicionar' }).click()
  await expect(page.getByText('Pedido de ' + nome('E2E Aberta B'))).toBeVisible()
  await expect(subtotal()).toContainText('R$ 7,00')
  await page.getByRole('button', { name: 'Remover' }).click()
})

test('loja fechada por horário e loja com a chave manual desligada não deixam adicionar', async () => {
  for (const [k, item] of [['foraDoHorario', 'Agua fora E2E'], ['manualOff', 'Agua fechada E2E']] as const) {
    await page.goto(lojaUrl(k))
    await expect(page.locator('header [data-open]')).toHaveAttribute('data-open', 'false')
    await expect(adicionar(item)).toBeDisabled()
    await expect(artigo(item)).toContainText('Loja fechada')
  }
})

test('em pesos, o preço de vitrine é o convertido com teto e todo valor usa a classe tabular', async () => {
  await withDb(async (q) => void (await q(`update public.profiles set currency_pref = 'UYU' where id = $1`, [cliente.id])))
  await page.goto(lojaUrl('A'))
  const { rate, spreadPct } = await taxaVigente()
  await expect(artigo('Lanche E2E').locator('.preco').first()).toHaveText(`$U ${convertBrlToUyu(19.9, rate, spreadPct).toLocaleString('es-UY')}`)

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
  await withDb(async (q) => void (await q(`update public.profiles set currency_pref = 'BRL' where id = $1`, [cliente.id])))
})

test('as duas telas cabem em 360 px sem rolagem lateral', async () => {
  for (const url of ['/lojas', lojaUrl('A')]) {
    await page.goto(url)
    const w = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
    expect(w.scroll).toBeLessThanOrEqual(w.client)
  }
})
