import { test } from '@playwright/test'
import { cleanupUsers, createUser, expect, setProfile, signInViaUi, withDb, type TestUser } from './auth-helpers'

// Console de despacho no navegador, contra o build de produção e o Supabase real. O que só o navegador prova:
// a página lista só pedidos ativos, desenha SÓ os botões que o banco aceita, e a atribuição e a transição
// feitas pela tela chegam ao banco com o ator e o motivo certos.
//
// Linhas criadas: usuários (pela API de admin do GoTrue), dois motoboys, e pedidos com código E2D***. Tudo é
// apagado no fim (pedidos primeiro; order_events cai em cascata) e o último teste confere que nada sobrou.
test.describe.configure({ mode: 'serial' })

const CODES = { fila: 'E2DA01', preparo: 'E2DB02', velho: 'E2DC03', encerrado: 'E2DD04' }
let admin: TestUser
let client: TestUser
let courier: TestUser
let courierName: string
let shopId: string
const orderIds: Record<string, string> = {}
const userIds: string[] = []

async function cleanup() {
  await withDb(async (q) => {
    await q(`delete from public.orders where code = any($1::text[])`, [Object.values(CODES)])
    if (userIds.length) {
      await q(`delete from public.courier_events where courier_id = any($1::uuid[])`, [userIds])
      await q(`delete from public.couriers where profile_id = any($1::uuid[])`, [userIds])
    }
  })
  await cleanupUsers()
}

test.beforeAll(async () => {
  await cleanup() // sobras de uma execução que morreu no meio
  admin = await createUser('dispatch-admin')
  client = await createUser('dispatch-client')
  courier = await createUser('dispatch-courier')
  userIds.push(admin.id, client.id, courier.id)
  courierName = `Motoboy E2E ${courier.id.slice(0, 6)}`
  await setProfile(admin.id, { role: 'admin', full_name: 'Admin E2E' })
  await setProfile(client.id, { full_name: 'Cliente E2E' })
  await setProfile(courier.id, { role: 'courier', full_name: courierName })
  await withDb(async (q) => {
    await q(`insert into public.couriers (profile_id, vehicle, base_city, status) values ($1, 'moto', 'quarai', 'approved')`, [courier.id])
    shopId = String((await q(`select id from public.merchants where city = 'quarai' limit 1`))[0].id)
    const addr = JSON.stringify({ city: 'quarai', street_name: 'Rua E2E', number: '10' })
    const mk = async (code: string, kind: string, status: string, merchant: string | null) => {
      const r = await q(
        `insert into public.orders (code, kind, client_id, merchant_id, pickup_address, dropoff_address, status, total_brl, total_charged, payment_method)
         values ($1, $2, $3, $4, $5::jsonb, $5::jsonb, $6, 20, 20, 'pix') returning id`,
        [code, kind, client.id, merchant, addr, status],
      )
      orderIds[code] = String(r[0].id)
    }
    await mk(CODES.fila, 'courier', 'aguardando_motoboy', null)
    await mk(CODES.preparo, 'food', 'em_preparo', shopId)
    await mk(CODES.velho, 'food', 'aguardando_loja', shopId)
    await mk(CODES.encerrado, 'courier', 'entregue', null)
  })
})
test.afterAll(cleanup)

const row = (page: import('@playwright/test').Page, code: string) => page.locator(`tr[data-code="${code}"]`)
const buttonNames = async (r: import('@playwright/test').Locator) =>
  (await r.getByRole('button').allTextContents()).map((s) => s.trim()).sort()

test('quem não é admin não vê o console', async ({ page }) => {
  await signInViaUi(page, client, { next: '/admin/despacho' })
  await expect(page).not.toHaveURL(/\/admin/)
  await expect(page.getByRole('heading', { name: 'Despacho' })).toHaveCount(0)
})

test.describe('como admin', () => {
  test.beforeEach(async ({ page }) => {
    await signInViaUi(page, admin, { next: '/admin/despacho' })
    await expect(page.getByRole('heading', { name: 'Despacho' })).toBeVisible()
  })

  test('lista só pedidos ativos e desenha só os botões legais de cada um', async ({ page }) => {
    await expect(row(page, CODES.fila)).toBeVisible()
    await expect(row(page, CODES.preparo)).toBeVisible()
    await expect(row(page, CODES.encerrado)).toHaveCount(0) // entregue sai da lista

    // Encomenda na fila, sem motoboy: o único passo adiante é cancelar. "Aceito" não aparece (exige motoboy:
    // o caminho é atribuir), nem estados que não existem no fluxo de encomenda (pronto, em_rota...).
    const fila = row(page, CODES.fila)
    await expect(fila.getByTestId('waiting')).toBeVisible()
    expect(await buttonNames(fila)).toEqual(['Atribuir', 'Cancelar pedido'])
    // o ajuste manual só oferece estados do fluxo e nunca o atual
    await fila.getByText('Ajuste manual').click()
    const manual = await fila.locator('select[name="to"] option').allTextContents()
    expect(manual).toEqual(['Novo estado…', 'Criado'])

    // Comida em preparo: pronto e cancelar. Entregue, em rota, coletado... nunca como botão.
    const preparo = row(page, CODES.preparo)
    expect(await buttonNames(preparo)).toEqual(['Atribuir', 'Cancelar pedido', 'Marcar: Pronto para retirar'])
  })

  test('atribuir motoboy pela tela: exige motivo, copia o motoboy e o evento leva o ator e o motivo', async ({ page }) => {
    const fila = row(page, CODES.fila)
    const option = fila.locator('select[name="courier"] option', { hasText: courierName })
    await fila.getByLabel('Motoboy').selectOption(String(await option.getAttribute('value')))
    // motivo vazio: o navegador nem envia
    await fila.getByRole('button', { name: 'Atribuir' }).click()
    await expect(fila.getByTestId('waiting')).toBeVisible()
    await fila.getByLabel('Motivo da atribuição').fill('pedido por rádio')
    await fila.getByRole('button', { name: 'Atribuir' }).click()

    await expect(fila.getByTestId('status')).toHaveText('Aceito pelo motoboy')
    await expect(fila.getByTestId('courier')).toContainText(courierName)
    await expect(fila.getByTestId('waiting')).toHaveCount(0)
    const [o] = await withDb((q) => q(`select status, courier_id, fleet_id from public.orders where id = $1`, [orderIds[CODES.fila]]))
    expect(o).toEqual({ status: 'aceito', courier_id: courier.id, fleet_id: null })
    const ev = await withDb((q) => q(`select from_status, to_status, actor_id, actor_role, note from public.order_events where order_id = $1`, [orderIds[CODES.fila]]))
    expect(ev).toHaveLength(1)
    expect(ev[0]).toMatchObject({ from_status: 'aguardando_motoboy', to_status: 'aceito', actor_id: admin.id, actor_role: 'admin' })
    expect(String(ev[0].note)).toContain('pedido por rádio')
    expect(String(ev[0].note)).toContain(courier.id)
    // agora com motoboy, "Aceito" não é mais botão e o resto do fluxo da encomenda aparece
    const after = await buttonNames(fila)
    expect(after).toEqual(expect.arrayContaining(['Cancelar pedido', 'Marcar: Coletado']))
    expect(after).not.toContain('Marcar: Aceito pelo motoboy')
  })

  test('transição pela tela exige motivo e grava o evento do admin; cancelar grava motivo e autor', async ({ page }) => {
    const preparo = row(page, CODES.preparo)
    await preparo.getByRole('button', { name: 'Marcar: Pronto para retirar' }).click() // sem motivo: não envia
    await expect(preparo.getByTestId('status')).toHaveText('Em preparo')
    await preparo.getByLabel('Motivo', { exact: true }).fill('a cozinha avisou')
    await preparo.getByRole('button', { name: 'Marcar: Pronto para retirar' }).click()
    await expect(preparo.getByTestId('status')).toHaveText('Pronto para retirar')
    await expect(preparo.getByTestId('waiting')).toBeVisible() // pronto sem motoboy = fila da comida

    await preparo.getByLabel('Motivo', { exact: true }).fill('cliente desistiu por telefone')
    await preparo.getByRole('button', { name: 'Cancelar pedido' }).click()
    await expect(row(page, CODES.preparo)).toHaveCount(0) // cancelado sai da lista

    const [o] = await withDb((q) => q(`select status, cancel_reason, cancelled_by from public.orders where id = $1`, [orderIds[CODES.preparo]]))
    expect(o).toEqual({ status: 'cancelado', cancel_reason: 'cliente desistiu por telefone', cancelled_by: admin.id })
    const ev = await withDb((q) => q(`select from_status, to_status, actor_role, note from public.order_events where order_id = $1 order by id`, [orderIds[CODES.preparo]]))
    expect(ev).toEqual([
      { from_status: 'em_preparo', to_status: 'pronto', actor_role: 'admin', note: 'a cozinha avisou' },
      { from_status: 'pronto', to_status: 'cancelado', actor_role: 'admin', note: 'cliente desistiu por telefone' },
    ])
  })

  test('tela desatualizada: o banco recusa e o operador vê uma mensagem, não um erro', async ({ page }) => {
    const velho = row(page, CODES.velho)
    await expect(velho.getByTestId('status')).toHaveText('Aguardando a loja')
    // outra pessoa (a loja) move o pedido enquanto a tela continua aberta
    await withDb((q) => q(`update public.orders set status = 'em_preparo' where id = $1`, [orderIds[CODES.velho]]))
    await velho.getByLabel('Motivo', { exact: true }).fill('loja avisou')
    await velho.getByRole('button', { name: 'Marcar: Em preparo' }).click()
    await expect(page.getByTestId('dispatch-error')).toContainText('já mudou')
    await expect(row(page, CODES.velho).getByTestId('status')).toHaveText('Em preparo')
    const ev = await withDb((q) => q(`select count(*)::int as n from public.order_events where order_id = $1`, [orderIds[CODES.velho]]))
    expect(ev[0].n).toBe(0) // a recusa não deixa rastro
  })
})

test('limpeza: nada do teste sobra no banco', async () => {
  await cleanup()
  const r = await withDb((q) => q(
    `select (select count(*)::int from public.orders where code = any($1::text[])) as orders,
            (select count(*)::int from auth.users where id = any($2::uuid[])) as users,
            (select count(*)::int from public.merchants) as merchants`,
    [Object.values(CODES), userIds],
  ))
  expect(r[0]).toMatchObject({ orders: 0, users: 0 })
  expect(r[0].merchants).toBeGreaterThanOrEqual(2) // os lojistas semeados continuam lá
})
