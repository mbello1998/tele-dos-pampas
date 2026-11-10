import { test } from '@playwright/test'
import { cleanupUsers, createUser, expect, leftovers, readProfile, setProfile, signInViaUi } from './auth-helpers'

// Contra o build de produção, com o Supabase real. Os usuários são criados pela API de admin do GoTrue (nenhum
// e-mail sai) e apagados no fim; o que sobra no banco é conferido no último teste.
test.describe.configure({ mode: 'serial' }) // um usuário por vez: o Auth limita conferências de código por IP

const createdIds: string[] = []
const user = async (tag: string) => {
  const u = await createUser(tag)
  createdIds.push(u.id)
  return u
}

test.afterAll(async () => {
  await cleanupUsers()
})

test.describe('sem conta', () => {
  test('rotas protegidas mandam para /entrar com o destino', async ({ page }) => {
    for (const [path, expected] of [
      ['/admin', '/entrar?next=%2Fadmin'],
      ['/admin/despacho', '/entrar?next=%2Fadmin%2Fdespacho'],
      // sem página alguma: só o middleware pode redirecionar (sem ele seria um 404)
      ['/admin/nao-existe', '/entrar?next=%2Fadmin%2Fnao-existe'],
      // com extensão no fim: o matcher que pula arquivos estáticos não pode deixar /admin escapar
      ['/admin/export.csv', '/entrar?next=%2Fadmin%2Fexport.csv'],
      ['/perfil', '/entrar?next=%2Fperfil'],
      ['/onboarding', '/entrar?next=%2Fonboarding'],
      ['/aguardando', '/entrar'],
    ] as const) {
      await page.goto(path)
      await expect(page, path).toHaveURL(new RegExp(`${expected.replace(/[?]/g, '\\?')}$`))
    }
  })

  test('código errado mostra o erro e continua na tela', async ({ page }) => {
    const u = await user('wrongcode')
    await signInViaUi(page, u, { code: '00000000' })
    await expect(page.locator('p[role="alert"]')).toContainText('Código incorreto ou vencido')
    await expect(page).toHaveURL(/\/entrar/)
    // nenhuma sessão nasceu
    await page.goto('/perfil')
    await expect(page).toHaveURL(/\/entrar\?next=%2Fperfil$/)
  })

  test('e-mail inválido é recusado na tela, sem pedir nada ao servidor', async ({ page }) => {
    await page.goto('/entrar')
    await page.getByLabel('E-mail').fill('isto-nao-e-email')
    await page.getByRole('button', { name: 'Enviar código' }).click()
    await expect(page.locator('p[role="alert"]')).toContainText('Confira o e-mail digitado')
  })
})

test.describe('idioma', () => {
  test.describe('navegador em espanhol do Uruguai', () => {
    test.use({ locale: 'es-UY' })
    test('Accept-Language es-UY: tela em espanhol', async ({ page }) => {
      await page.goto('/entrar')
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ingresar')
      await expect(page.locator('div[lang="es-UY"]').first()).toBeVisible()
    })
  })

  test.describe('navegador em português do Brasil', () => {
    test.use({ locale: 'pt-BR' })
    test('Accept-Language pt-BR: tela em português', async ({ page }) => {
      await page.goto('/entrar')
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Entrar')
    })

    test('anônimo troca o idioma: vai para o cookie e ele vale na próxima visita, mesmo contra o navegador', async ({ page, context }) => {
      await page.goto('/entrar')
      await page.getByRole('button', { name: 'Español' }).click()
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ingresar')
      const cookie = (await context.cookies()).find((c) => c.name === 'tdp_locale')
      expect(cookie?.value).toBe('es-UY')
      await page.goto('/entrar')
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ingresar')
    })
  })

  test.describe('navegador em inglês com espanhol como segunda opção', () => {
    test.use({ locale: 'en-US' })
    test('vence o maior q entre os idiomas que o app tem', async ({ page }) => {
      // o Chromium impõe o próprio Accept-Language ao `locale`; só a interceptação entrega a lista composta
      await page.route('**/entrar', (route) =>
        route.continue({ headers: { ...route.request().headers(), 'accept-language': 'en-US,es;q=0.5,pt;q=0.4' } }),
      )
      await page.goto('/entrar')
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ingresar')
    })
  })
})

test.describe('cadastro, onboarding e perfil (cliente)', () => {
  test('usuário novo: perfil client/active pelo caminho real do GoTrue, onboarding, e idioma e moeda independentes', async ({ page }) => {
    const u = await user('client')

    // o trigger on_auth_user_created, disparado pelo supabase_auth_admin de verdade
    expect(await readProfile(u.id)).toMatchObject({ role: 'client', status: 'active', full_name: null, locale: 'pt-BR', currency_pref: 'BRL' })

    await signInViaUi(page, u, { next: '/perfil' })
    await expect(page).toHaveURL(/\/onboarding\?next=%2Fperfil$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Vamos começar')

    await page.getByLabel('Nome', { exact: true }).fill('  Ana Souza  ')
    // sem cidade o onboarding não conclui
    await page.getByRole('button', { name: 'Continuar' }).click()
    await expect(page.locator('p[role="alert"]')).toContainText('Confira os campos')

    // escolher Artigas sugere pesos (a pessoa ainda não mexeu na moeda)
    await page.getByLabel('Cidade').selectOption('artigas')
    await expect(page.getByLabel('Ver preços em')).toHaveValue('UYU')
    await expect(page.getByTestId('currency-preview')).toHaveText('$U 25')

    // mas idioma e moeda são independentes: espanhol com preços em reais
    await page.getByLabel('Idioma').selectOption('es-UY')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Empecemos') // a tela inteira acompanha o idioma escolhido
    await expect(page.getByLabel('Ver precios en')).toHaveValue('UYU') // trocar o idioma não mexeu na moeda
    await page.getByLabel('Ver precios en').selectOption('BRL')
    await expect(page.getByLabel('Idioma')).toHaveValue('es-UY') // e trocar a moeda não mexeu no idioma
    await expect(page.getByTestId('currency-preview')).toHaveText('R$ 25,00')

    await page.getByRole('button', { name: 'Continuar' }).click()
    await expect(page).toHaveURL(/\/perfil$/)
    expect(await readProfile(u.id)).toMatchObject({
      role: 'client', status: 'active', full_name: 'Ana Souza', locale: 'es-UY', currency_pref: 'BRL', home_city: 'artigas', country: 'UY',
    })

    // o perfil manda: a tela agora vem em espanhol mesmo com o navegador sem preferência
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tu perfil')
    await expect(page.getByTestId('account-email')).toHaveText(u.email)

    // muda SÓ a moeda: o idioma do banco não se mexe
    await page.getByLabel('Ver precios en').selectOption('UYU')
    await page.getByRole('button', { name: 'Guardar' }).click()
    await expect(page.getByRole('status')).toContainText('Cambios guardados')
    expect(await readProfile(u.id)).toMatchObject({ locale: 'es-UY', currency_pref: 'UYU' })

    // muda SÓ o idioma: a moeda do banco não se mexe (brasileiro vendo pesos, aqui o inverso do cadastro)
    await page.getByLabel('Idioma').selectOption('pt-BR')
    await page.getByRole('button', { name: 'Salvar' }).click()
    await expect(page.getByRole('status')).toContainText('Alterações salvas')
    expect(await readProfile(u.id)).toMatchObject({ locale: 'pt-BR', currency_pref: 'UYU' })
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Seu perfil')

    // celular opcional: normaliza e limpa
    await page.getByLabel('Celular (opcional)').fill('+55 (55) 99123-4567')
    await page.getByRole('button', { name: 'Salvar' }).click()
    await expect(page.getByRole('status')).toBeVisible()
    expect(await readProfile(u.id)).toMatchObject({ phone: '+5555991234567' })

    // cliente comum não entra em /admin: o middleware o devolve para a home
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/$/)
    await page.goto('/admin/despacho')
    await expect(page).toHaveURL(/\/$/)
    await page.goto('/admin/nao-existe') // só o middleware pode barrar uma rota sem página
    await expect(page).toHaveURL(/\/$/)

    // quem já entrou não vê o formulário de entrada
    await page.goto('/entrar')
    await expect(page).toHaveURL(/\/$/)

    // o papel segue o do cadastro
    expect(await readProfile(u.id)).toMatchObject({ role: 'client', status: 'active' })

    // sair derruba a sessão
    await page.goto('/perfil')
    await page.getByRole('button', { name: 'Sair' }).click()
    await expect(page).toHaveURL(/\/entrar$/)
    await page.goto('/perfil')
    await expect(page).toHaveURL(/\/entrar\?next=%2Fperfil$/)
  })

  test('destino pós-login malicioso é ignorado: o usuário fica no próprio site', async ({ page, baseURL }) => {
    const u = await user('redirect')
    await setProfile(u.id, { full_name: 'Teste Redirect' })
    await signInViaUi(page, u, { next: '//evil.example/roubo' })
    await expect(page).toHaveURL(`${baseURL}/`)
    await page.goto('/entrar?next=https://evil.example')
    await expect(page).toHaveURL(`${baseURL}/`)
  })
})

test.describe('/admin', () => {
  test('admin ativo entra; admin bloqueado não', async ({ page }) => {
    const u = await user('admin')
    await setProfile(u.id, { role: 'admin', full_name: 'Admin Teste' })
    await signInViaUi(page, u, { next: '/admin' })
    await expect(page).toHaveURL(/\/admin$/)
    await expect(page.getByRole('heading', { name: 'Painel do admin' })).toBeVisible()

    // bloqueado no banco: o mesmo cookie de sessão, e agora o middleware recusa (como o RLS: sem privilégio)
    await setProfile(u.id, { status: 'blocked' })
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/aguardando$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Conta bloqueada')
  })
})

test.describe('cadastro à espera de aprovação', () => {
  test('entregador pendente vê a tela de espera, e nada além dela', async ({ page }) => {
    const u = await user('pending')
    await setProfile(u.id, { role: 'courier', status: 'pending' })
    await signInViaUi(page, u)
    await expect(page).toHaveURL(/\/aguardando$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Cadastro em análise')
    await expect(page.locator('[data-status="pending"]')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Verificar de novo' })).toBeVisible()

    for (const path of ['/perfil', '/onboarding', '/admin']) {
      await page.goto(path)
      await expect(page, path).toHaveURL(/\/aguardando$/)
    }

    // a aprovação pelo admin abre o app sem novo login
    await setProfile(u.id, { status: 'active', full_name: 'Motoboy Aprovado' })
    await page.getByRole('link', { name: 'Verificar de novo' }).click()
    await expect(page).toHaveURL(/\/$/)
  })

  test('conta bloqueada vê o aviso de bloqueio, sem botão de verificar de novo', async ({ page }) => {
    const u = await user('blocked')
    await setProfile(u.id, { status: 'blocked' })
    await signInViaUi(page, u)
    await expect(page).toHaveURL(/\/aguardando$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Conta bloqueada')
    await expect(page.getByRole('link', { name: 'Verificar de novo' })).toHaveCount(0)
  })
})

test('nada ficou para trás no banco compartilhado', async () => {
  await cleanupUsers()
  expect(await leftovers(createdIds)).toEqual({ users: 0, profiles: 0, audit: 0 })
})
