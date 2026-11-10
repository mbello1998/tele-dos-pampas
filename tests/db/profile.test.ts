import type { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { connect } from '../../scripts/db/client'
import { assertNewUserIsClientActive, assertRoleAndStatusAreFrozen, liveNewUser } from './profile-assertions'
import { actAs, asOwner, attempt, FIXTURE_SQL, ID, readAs } from './rls-helpers'

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 })

let db: Client
beforeAll(async () => {
  db = await connect()
})
afterAll(async () => {
  await db.end()
})
// The database is shared: every test runs inside a transaction that is always rolled back.
beforeEach(async () => {
  await db.query('begin')
  await db.query(FIXTURE_SQL)
})
afterEach(async () => {
  await db.query('rollback')
})

const clientA = { uid: ID.clientA }

describe('criação do perfil no cadastro (on_auth_user_created)', () => {
  test('novo usuário recebe profile com role client e status active', async () => {
    await assertNewUserIsClientActive(db, liveNewUser)
  })

  test('o perfil nasce com os padrões da fronteira e nada escolhido pelo usuário', async () => {
    const id = 'a0000000-0000-4000-8000-0000000000b1'
    await liveNewUser.createUser(db, id, { full_name: 'Quem se diz admin', locale: 'es-UY', currency_pref: 'UYU' })
    const [p] = await asOwner(db, `select role, status, full_name, phone, locale, currency_pref, home_city, country from public.profiles where id = $1`, [id])
    expect(p).toEqual({
      role: 'client', status: 'active', full_name: null, phone: null, locale: 'pt-BR', currency_pref: 'BRL', home_city: null, country: null,
    })
  })

  test('o trigger é AFTER INSERT em auth.users, habilitado, e a função tem search_path fixo', async () => {
    const [t] = await asOwner<{ enabled: string; type: number; secdef: boolean; config: string[] | null }>(
      db,
      `select t.tgenabled as enabled, t.tgtype::int as type, p.prosecdef as secdef, p.proconfig as config
         from pg_trigger t join pg_proc p on p.oid = t.tgfoid
        where t.tgrelid = 'auth.users'::regclass and t.tgname = 'on_auth_user_created' and not t.tgisinternal`,
    )
    expect(t).toBeDefined()
    expect(t.enabled).toBe('O')
    expect(t.type & 1).toBe(1) // ROW
    expect(t.type & 2).toBe(0) // not BEFORE
    expect(t.type & 4).toBe(4) // INSERT
    expect(t.secdef).toBe(true)
    expect(t.config).toContain('search_path=""')
  })

  test('a função do trigger não é executável por anon, authenticated nem pela API', async () => {
    const [f] = await asOwner<{ anon: boolean; auth: boolean }>(
      db,
      `select has_function_privilege('anon', 'private.handle_new_user()', 'execute') anon,
              has_function_privilege('authenticated', 'private.handle_new_user()', 'execute') auth`,
    )
    expect(f).toEqual({ anon: false, auth: false })
  })
})

describe('o role não é do usuário', () => {
  test('usuário não pode alterar o próprio role', async () => {
    await assertRoleAndStatusAreFrozen(db, 'public.profiles')
  })

  test('o guard que já existe cobre role, status e id: nenhuma das três colunas está na lista permitida', async () => {
    const [g] = await asOwner<{ args: string }>(
      db,
      `select encode(t.tgargs, 'escape') as args from pg_trigger t
        where t.tgrelid = 'public.profiles'::regclass and t.tgname = 'restrict_update_columns'`,
    )
    expect(g, 'o trigger restrict_update_columns de profiles tem de existir').toBeDefined()
    const allowed = g.args.split('\\000').filter(Boolean)
    expect(allowed.sort()).toEqual(['country', 'currency_pref', 'full_name', 'home_city', 'locale', 'phone'])
    for (const col of ['role', 'status', 'id', 'created_at']) expect(allowed).not.toContain(col)
  })

  test('conta pending não se ativa sozinha: o UPDATE não alcança a linha, e o status segue pending', async () => {
    await actAs(db, { uid: ID.pendingCourier })
    const a = await attempt(db, `update profiles set status = 'active' where id = $1`, [ID.pendingCourier])
    if (a.ok) expect(a.rowCount).toBe(0)
    const [p] = await asOwner<{ status: string; role: string }>(db, `select status, role from profiles where id = $1`, [ID.pendingCourier])
    expect(p).toEqual({ status: 'pending', role: 'courier' })
  })

  test('conta pending também não consegue mudar o próprio nome: sem aprovação não há escrita', async () => {
    await actAs(db, { uid: ID.pendingCourier })
    const a = await attempt(db, `update profiles set full_name = 'x' where id = $1`, [ID.pendingCourier])
    if (a.ok) expect(a.rowCount).toBe(0)
    const [p] = await asOwner<{ full_name: string }>(db, `select full_name from profiles where id = $1`, [ID.pendingCourier])
    expect(p.full_name).toBe('Motoboy pendente')
  })
})

describe('locale e currency_pref são independentes', () => {
  const read = async () =>
    (await asOwner<{ locale: string; currency_pref: string }>(db, `select locale, currency_pref from profiles where id = $1`, [ID.clientA]))[0]

  test('locale e currency_pref são salvos independentemente', async () => {
    expect(await read()).toEqual({ locale: 'pt-BR', currency_pref: 'BRL' })

    await actAs(db, clientA)
    expect((await attempt(db, `update profiles set locale = 'es-UY' where id = $1`, [ID.clientA])).ok).toBe(true)
    expect(await read()).toEqual({ locale: 'es-UY', currency_pref: 'BRL' }) // só o idioma mudou

    await actAs(db, clientA)
    expect((await attempt(db, `update profiles set currency_pref = 'UYU' where id = $1`, [ID.clientA])).ok).toBe(true)
    expect(await read()).toEqual({ locale: 'es-UY', currency_pref: 'UYU' }) // só a moeda mudou

    await actAs(db, clientA)
    expect((await attempt(db, `update profiles set locale = 'pt-BR' where id = $1`, [ID.clientA])).ok).toBe(true)
    expect(await read()).toEqual({ locale: 'pt-BR', currency_pref: 'UYU' }) // brasileiro vendo preço em pesos
  })

  test.each([
    ['pt-BR', 'BRL'], ['pt-BR', 'UYU'], ['es-UY', 'BRL'], ['es-UY', 'UYU'],
  ])('a combinação %s + %s persiste', async (locale, currency) => {
    await actAs(db, clientA)
    const r = await attempt(db, `update profiles set locale = $1, currency_pref = $2 where id = $3`, [locale, currency, ID.clientA])
    expect(r.ok).toBe(true)
    expect(await read()).toEqual({ locale, currency_pref: currency })
  })

  test('valores fora do conjunto são recusados pelo banco (CHECK)', async () => {
    for (const set of [`locale = 'en-US'`, `locale = 'es'`, `currency_pref = 'USD'`, `currency_pref = 'brl'`]) {
      await actAs(db, clientA)
      const r = await attempt(db, `update profiles set ${set} where id = $1`, [ID.clientA])
      expect(r.ok, set).toBe(false)
      if (!r.ok) expect(r.code, set).toBe('23514')
    }
    expect(await read()).toEqual({ locale: 'pt-BR', currency_pref: 'BRL' })
  })
})

describe('pending e blocked leem só o próprio perfil, e nada além dele', () => {
  const OTHER_TABLES = ['orders', 'order_items', 'merchants', 'catalog_items', 'couriers', 'fleets', 'addresses', 'order_events', 'courier_positions']

  test.each([
    ['pending', ID.pendingCourier],
    ['blocked', ID.blockedAdmin],
  ])('conta %s: só a própria linha de profiles', async (_label, uid) => {
    expect(await readAs(db, { uid }, `select id from profiles`)).toEqual([uid])
    // ... e a própria linha traz o status, que é o que a tela de espera precisa
    await actAs(db, { uid })
    const own = await db.query(`select status, role from profiles where id = $1`, [uid])
    expect(own.rows).toHaveLength(1)
    expect(['pending', 'blocked']).toContain(own.rows[0].status)
  })

  test.each([
    ['pending', ID.pendingCourier],
    ['blocked', ID.blockedAdmin],
  ])('conta %s: nenhuma outra tabela devolve linha, mesmo com dados de outros no banco', async (_label, uid) => {
    // o pré-requisito: os dados existem (visíveis ao dono). Sem isto, "zero linhas" não provaria nada.
    for (const t of ['orders', 'merchants', 'catalog_items', 'couriers', 'fleets', 'addresses']) {
      const n = await asOwner<{ n: number }>(db, `select count(*)::int n from ${t}`)
      expect(n[0].n, `${t} precisa ter dados no fixture`).toBeGreaterThan(0)
    }
    await actAs(db, { uid })
    for (const t of OTHER_TABLES) {
      const r = await db.query(`select count(*)::int n from ${t}`)
      expect(r.rows[0].n, `${t} para conta ${_label}`).toBe(0)
    }
  })

  test('uma conta ativa enxerga só o próprio perfil também (cliente não lê o de ninguém)', async () => {
    expect(await readAs(db, clientA, `select id from profiles`)).toEqual([ID.clientA])
  })

  test('app_role() é nulo para pending e blocked: sem papel, sem privilégio (e nunca a string "authenticated")', async () => {
    for (const uid of [ID.pendingCourier, ID.blockedAdmin]) {
      await actAs(db, { uid })
      const r = await db.query(`select public.app_role() as r, public.is_admin() as a`)
      expect(r.rows[0]).toEqual({ r: null, a: false })
    }
    await actAs(db, clientA)
    expect((await db.query(`select public.app_role() as r`)).rows[0].r).toBe('client')
  })
})
