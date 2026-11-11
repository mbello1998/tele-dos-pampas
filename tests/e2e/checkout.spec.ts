import { expect, test } from '@playwright/test'

// Confirmação do pedido no navegador real, contra o build de produção.
//
// Fatia 1b, passo 1: a confirmação deixou de passar pelo carrinho de uma loja (não há mais cardápio nem carrinho).
// Sobrou o que não dependia dele: o acesso sem sessão. O resto do spec (preço cotado, preço que muda entre ver e
// confirmar, pedido criado, loja que fecha) montava o pedido a partir de um item de cardápio e foi removido junto
// com ele; a cobertura equivalente para mototáxi e encomenda fica para quando a tela de pedido existir (passo 2).

test('sem sessão, /pedido/novo manda para o login e volta para o destino', async ({ browser }) => {
  const ctx = await browser.newContext()
  const anon = await ctx.newPage()
  await anon.goto('/pedido/novo?kind=courier')
  await expect(anon).toHaveURL(/\/entrar\?next=%2Fpedido%2Fnovo%3Fkind%3Dcourier/)
  await ctx.close()
})
