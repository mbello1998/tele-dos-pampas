import { expect, type Page, type Response, test } from '@playwright/test'
import { cleanupUsers, createUser, setProfile, signInViaUi, withDb, type TestUser } from './auth-helpers'

// Confirmação do pedido no navegador real, contra o build de produção e o banco compartilhado.
//
// O que só um navegador prova: que a tela mostra o preço que o SERVIDOR cotou, que o que o cliente vê é o que o
// pedido grava, que um preço que mudou entre ver e confirmar é recusado (e a tela mostra o novo total), que uma loja
// que fechou nesse intervalo também, e que a comissão da loja nunca viaja ao navegador.
//
// DADOS: o spec cria a própria loja (aprovada, sem dono, com horário de 24 h), um item e um endereço do cliente, e
// REMOVE tudo no fim, inclusive os pedidos que criou e as linhas de audit_log que as tabelas auditadas geraram.
// A comissão da loja é um valor reconhecível (12,34) para provar que não chega ao HTML nem às respostas das actions.
//
// RELÓGIO: o serviço funciona das 06:00 às 00:00 (regra do município, em settings). Fora disso o servidor recusa
// todo pedido, e é o comportamento correto: o spec se pula nessa janela em vez de simular um relógio que o banco
// não aceitaria.
const TAG = `e2e${Date.now().toString(36)}`
const COMISSAO = '12.34'
const PRECO_ITEM = 19.9

const emHorarioDeServico = () => {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Montevideo', hour: '2-digit', hour12: false }).format(new Date()))
  return h >= 6 // 00:00 até 05:59 está fechado
}

type Seeds = { merchant: string; item: string; hours: string[]; address: string }
let seeds: Seeds
let cliente: TestUser
let page: Page

const carrinho = (item: string, merchant: string) => ({
  merchantId: merchant,
  merchantName: `E2E Loja ${TAG}`,
  lines: [
    {
      lineId: 'linha-e2e',
      item: { id: item, merchantId: merchant, name: 'Lanche E2E', description: null, priceBrl: PRECO_ITEM, photoUrl: null, isAvailable: true, groups: [] },
      optionIds: [],
      qty: 1,
    },
  ],
})

async function semear(clienteId: string): Promise<Seeds> {
  return withDb(async (q) => {
    const merchant = String(
      (
        await q(
          `insert into public.merchants (name, kind, city, country, address_text, lat, lng, prep_time_min, commission_pct, is_open_manual, accepts_cross_border, status)
           values ($1, 'trailer', 'quarai', 'BR', 'Rua de teste', -30.3791, -56.4514, 15, ${COMISSAO}, true, true, 'approved') returning id`,
          [`E2E Loja ${TAG}`],
        )
      )[0].id,
    )
    const hours: string[] = []
    for (let d = 0; d < 7; d++) {
      hours.push(String((await q(`insert into public.merchant_hours (merchant_id, weekday, opens_at, closes_at) values ($1, $2, '00:00', '00:00') returning id`, [merchant, d]))[0].id))
    }
    const item = String((await q(`insert into public.catalog_items (merchant_id, name, price_brl) values ($1, 'Lanche E2E', $2) returning id`, [merchant, PRECO_ITEM]))[0].id)
    const address = String(
      (
        await q(
          `insert into public.addresses (profile_id, label, street_id, street_name, number, reference, city, country, lat, lng, precision, is_default)
           values ($1, 'casa', 'e2e-rua', 'Rua E2E', '10', 'portão azul', 'quarai', 'BR', -30.385, -56.448, 'quadra', true) returning id`,
          [clienteId],
        )
      )[0].id,
    )
    return { merchant, item, hours, address }
  })
}

/** Apaga tudo o que o spec criou. Pedido não se apaga no produto; aqui é a limpeza de dados de teste, por cliente. */
async function limpar() {
  await withDb(async (q) => {
    const orders = (await q(`select id from public.orders where client_id = $1`, [cliente?.id ?? '00000000-0000-0000-0000-000000000000'])).map((r) => String(r.id))
    await q(`delete from public.orders where client_id = $1`, [cliente?.id ?? '00000000-0000-0000-0000-000000000000']) // cascata: itens, eventos, comissão
    if (seeds) {
      await q(`delete from public.merchants where id = $1`, [seeds.merchant]) // cascata: itens e horários
      await q(`delete from public.addresses where id = $1`, [seeds.address])
    }
    const registros = [...orders, ...(seeds ? [seeds.merchant, seeds.item, seeds.address, ...seeds.hours] : [])]
    await q(`delete from public.audit_log where record_id = any($1::text[]) or (action = 'price_mismatch' and actor_id = $2)`, [
      registros,
      cliente?.id ?? '00000000-0000-0000-0000-000000000000',
    ])
  })
}

const pedidosDoCliente = () => withDb((q) => q(`select id, code, total_brl::float8 as total, pricing_breakdown from public.orders where client_id = $1 order by created_at`, [cliente.id]))

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true })

test.beforeAll(async ({ browser }) => {
  cliente = await createUser('checkout')
  await setProfile(cliente.id, { full_name: 'Cliente Checkout' })
  seeds = await semear(cliente.id)
  const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true })
  page = await ctx.newPage()
  await signInViaUi(page, cliente, { next: '/' })
  await page.waitForURL('**/')
})

test.afterAll(async () => {
  await limpar()
  await cleanupUsers()
})

test('sem sessão, /pedido/novo manda para o login e volta para o destino', async ({ browser }) => {
  const ctx = await browser.newContext()
  const anon = await ctx.newPage()
  await anon.goto('/pedido/novo?kind=courier')
  await expect(anon).toHaveURL(/\/entrar\?next=%2Fpedido%2Fnovo%3Fkind%3Dcourier/)
  await ctx.close()
})

test('carrinho vazio: a tela manda ver as lojas e não oferece confirmar', async () => {
  await page.goto('/pedido/novo')
  await page.evaluate(() => sessionStorage.clear())
  await page.reload()
  await expect(page.getByText('Seu carrinho está vazio.')).toBeVisible()
  await expect(page.getByTestId('confirm-order')).toHaveCount(0)
})

test.describe('com o serviço aberto', () => {
  test.beforeEach(() => {
    test.skip(!emHorarioDeServico(), 'o serviço funciona das 06:00 às 00:00: fora disso o servidor recusa todo pedido (correto)')
  })

  async function abrirCheckout() {
    await page.goto('/pedido/novo')
    await page.evaluate(
      ([estado]) => sessionStorage.setItem('tdp.cart.v1', JSON.stringify(estado)),
      [carrinho(seeds.item, seeds.merchant)] as const,
    )
    await page.reload()
    await expect(page.getByTestId('checkout-form')).toBeVisible()
    await expect(page.getByTestId('confirm-order')).toBeEnabled({ timeout: 20_000 }) // a cotação do servidor chegou
  }

  test('mostra o preço cotado pelo servidor: itens e entrega, sem comissão em nenhuma resposta', async () => {
    const respostas: string[] = []
    const vigia = async (r: Response) => {
      const tipo = r.headers()['content-type'] ?? ''
      if (tipo.includes('text/html') || tipo.includes('text/x-component')) respostas.push(await r.text().catch(() => ''))
    }
    page.on('response', vigia)
    await abrirCheckout()
    page.off('response', vigia)

    const itens = page.locator('[data-line="items_subtotal"]')
    await expect(itens).toContainText('19,90')
    await expect(page.locator('[data-line="base"]')).toBeVisible() // a taxa de entrega veio do servidor
    await expect(page.locator('[data-total="brl"]')).toBeVisible()
    const tudo = respostas.join('\n').toLowerCase()
    expect(tudo).toContain('items_subtotal') // a captura funcionou: a resposta da action de cotação passou por aqui
    expect(tudo).not.toContain(COMISSAO)
    expect(tudo).not.toContain('commission')
    expect(tudo).not.toContain('comiss')
  })

  test('preço que mudou entre ver e confirmar: recusado, o novo total aparece e nenhum pedido nasce', async () => {
    await abrirCheckout()
    const antes = await page.locator('[data-total="brl"] dd').innerText()
    // a loja sobe o preço com a tela aberta
    await withDb((q) => q(`update public.catalog_items set price_brl = 29.90 where id = $1`, [seeds.item]))
    await page.getByTestId('confirm-order').click()
    await expect(page.getByText('Atualizamos o preço')).toBeVisible()
    await expect(page.locator('[data-line="items_subtotal"]')).toContainText('29,90', { timeout: 20_000 })
    const depois = await page.locator('[data-total="brl"] dd').innerText()
    expect(depois).not.toBe(antes)
    expect(await pedidosDoCliente()).toHaveLength(0)
    // a tentativa ficou registrada
    const log = await withDb((q) => q(`select count(*)::int n from public.audit_log where action = 'price_mismatch' and actor_id = $1`, [cliente.id]))
    expect(log[0].n).toBe(1)
  })

  test('confirmar com o total novo cria o pedido: código curto, preço congelado, comissão só no banco', async () => {
    await expect(page.getByTestId('confirm-order')).toBeEnabled({ timeout: 20_000 })
    await page.getByTestId('confirm-order').click()
    await page.waitForURL(/\/pedido\/[A-HJ-NP-Z2-9]{6}$/, { timeout: 30_000 })

    const pedidos = await pedidosDoCliente()
    expect(pedidos).toHaveLength(1)
    const [pedido] = pedidos
    expect(page.url()).toContain(String(pedido.code))
    const linhaItens = (pedido.pricing_breakdown as { key: string; amountBrl: number }[]).find((l) => l.key === 'items_subtotal')
    expect(linhaItens?.amountBrl).toBe(29.9)
    expect(JSON.stringify(pedido.pricing_breakdown)).not.toMatch(/commission|comiss/i)

    const comissao = await withDb((q) => q(`select commission_brl::float8 as c from public.order_commissions where order_id = $1`, [pedido.id]))
    expect(comissao).toEqual([{ c: Math.round(29.9 * 12.34) / 100 }]) // 12,34% de 29,90 = 3,69
    const eventos = await withDb((q) => q(`select to_status, actor_role from public.order_events where order_id = $1`, [pedido.id]))
    expect(eventos).toEqual([{ to_status: 'criado', actor_role: 'client' }])
    // o carrinho foi esvaziado: o pedido não se repete por um segundo toque ou um "voltar"
    expect(await page.evaluate(() => sessionStorage.getItem('tdp.cart.v1'))).toBeNull()
  })

  test('loja que fechou entre ver e confirmar: recusado com a razão, sem pedido novo', async () => {
    await abrirCheckout()
    await withDb((q) => q(`update public.merchants set is_open_manual = false where id = $1`, [seeds.merchant]))
    await page.getByTestId('confirm-order').click()
    await expect(page.getByRole('alert')).toContainText('A loja fechou')
    expect(await pedidosDoCliente()).toHaveLength(1) // só o do teste anterior
  })
})
