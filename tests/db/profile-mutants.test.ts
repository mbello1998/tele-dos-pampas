import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { connect } from '../../scripts/db/client'
import { assertNewUserIsClientActive, assertRoleAndStatusAreFrozen, type NewUserTarget } from './profile-assertions'
import { asOwner, FIXTURE_SQL, ID } from './rls-helpers'

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 })

/**
 * Mutation evidence for tests/db/profile.test.ts, without touching a single shared live object.
 *
 * Each case rebuilds the logic in the session's TEMP schema (pg_temp) from the TEXT of the migrations, inside a
 * transaction that is always rolled back, applies ONE deliberate defect to that text, and runs the very same
 * assertion functions the live tests run. 'baseline' (no defect) must pass: it proves the copy behaves like the
 * original. Every other case must make the assertion FAIL; a mutant that survives is a guard nobody tests.
 * Each edit must match the text exactly once, so a stale mutant throws instead of silently passing.
 */

type Edit = { from: string; to: string }

const read = (file: string) => readFileSync(resolve(process.cwd(), 'supabase/migrations', file), 'utf8').replace(/\r\n/g, '\n')
const extract = (sql: string, re: RegExp, what: string) => {
  const m = sql.match(re)
  if (!m) throw new Error(`não achei ${what} na migration`)
  return m[0]
}
// A definição vigente é a da 0019 (create or replace); a da 0008 é a original, sem o coalesce em tg_argv.
const GUARD_FN = extract(
  read('0019_commission_split_history_guards_audit.sql'),
  /create or replace function private\.restrict_update_columns\(\)[\s\S]*?\n\$\$;/,
  'restrict_update_columns',
)
const NEW_USER_FN = extract(read('0023_auth_new_user_profile.sql'), /create function private\.handle_new_user\(\)[\s\S]*?\n\$\$;/, 'handle_new_user')
const body = (fn: string) => fn.match(/\$\$([\s\S]*)\$\$/)![1]

const GUARD_TRIGGER = `create trigger restrict_update_columns before update on pg_temp.profiles_t
  for each row execute function pg_temp.restrict_update_columns('full_name', 'phone', 'locale', 'currency_pref', 'home_city', 'country');`
const NEW_USER_TRIGGER = `create trigger on_auth_user_created after insert on pg_temp.users_t
  for each row execute function pg_temp.handle_new_user();`

/** The mutant must be caught by an ASSERTION. A SQL error inside the broken copy is not evidence of anything. */
async function mustFailAnAssertion(run: Promise<unknown>) {
  const err = await run.then(() => null, (e: Error) => e)
  expect(err, 'o mutante sobreviveu: nenhuma asserção falhou').not.toBeNull()
  expect(err!.name, `falhou por outro motivo (erro de SQL na cópia?): ${err!.message}`).toBe('AssertionError')
}

function mutate(sql: string, edits: Edit[]) {
  let out = sql
  for (const e of edits) {
    const n = out.split(e.from).length - 1
    if (n !== 1) throw new Error(`mutante velho: o trecho aparece ${n} vez(es), esperava 1:\n${e.from}`)
    out = out.replace(e.from, () => e.to)
  }
  return out
}

let db: Client
beforeAll(async () => {
  db = await connect()
})
afterAll(async () => {
  await db.end()
})
beforeEach(async () => {
  await db.query('begin')
  await db.query(FIXTURE_SQL)
})
afterEach(async () => {
  await db.query('rollback')
})

async function buildNewUserCopy(fnEdits: Edit[], triggerEdits: Edit[] | 'none'): Promise<NewUserTarget> {
  await db.query(`
    create temp table users_t (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}');
    create temp table profiles_t (like public.profiles including defaults including constraints including indexes);`)
  const fn = mutate(NEW_USER_FN, fnEdits)
    .replace('private.handle_new_user', 'pg_temp.handle_new_user')
    .replace('public.profiles', 'pg_temp.profiles_t')
  await db.query(fn)
  if (triggerEdits !== 'none') await db.query(mutate(NEW_USER_TRIGGER, triggerEdits))
  return {
    async createUser(d, id, meta) {
      await asOwner(d, `insert into pg_temp.users_t (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`, [id, `${id}@x.invalid`, JSON.stringify(meta)])
    },
    async readProfile(d, id) {
      return (await asOwner<{ role: string; status: string }>(d, `select role, status from pg_temp.profiles_t where id = $1`, [id]))[0]
    },
  }
}

async function buildGuardCopy(fnEdits: Edit[], triggerEdits: Edit[] | 'none') {
  await db.query(`
    create temp table profiles_t (like public.profiles including defaults including constraints including indexes);
    insert into pg_temp.profiles_t select * from public.profiles;
    grant select, update on pg_temp.profiles_t to authenticated;`)
  await db.query(mutate(GUARD_FN, fnEdits).replace('create or replace function private.restrict_update_columns', 'create function pg_temp.restrict_update_columns'))
  if (triggerEdits !== 'none') await db.query(mutate(GUARD_TRIGGER, triggerEdits))
}

describe('a cópia em pg_temp é fiel ao que está implantado', () => {
  const live = async (fn: string) => (await asOwner<{ src: string }>(db, `select prosrc as src from pg_proc where oid = '${fn}'::regprocedure`))[0].src.replace(/\r\n/g, '\n')
  test('handle_new_user: corpo igual ao da migration', async () => {
    expect((await live('private.handle_new_user()')).trim()).toBe(body(NEW_USER_FN).trim())
  })
  test('restrict_update_columns: corpo igual ao da migration', async () => {
    expect((await live('private.restrict_update_columns()')).trim()).toBe(body(GUARD_FN).trim())
  })
})

describe('on_auth_user_created: o teste de criação de perfil pega cada defeito', () => {
  test('baseline (sem defeito) passa', async () => {
    await assertNewUserIsClientActive(db, await buildNewUserCopy([], []))
  })

  const mutants: Record<string, { fn?: Edit[]; trigger?: Edit[] | 'none' }> = {
    'papel vem do metadado do usuário': {
      fn: [{ from: `values (new.id, 'client', 'active')`, to: `values (new.id, coalesce(new.raw_user_meta_data ->> 'role', 'client')::public.user_role, 'active')` }],
    },
    'todo mundo nasce admin': { fn: [{ from: `values (new.id, 'client', 'active')`, to: `values (new.id, 'admin', 'active')` }] },
    'todo mundo nasce courier (papel de aprovação)': { fn: [{ from: `values (new.id, 'client', 'active')`, to: `values (new.id, 'courier', 'active')` }] },
    'status nasce pending': { fn: [{ from: `values (new.id, 'client', 'active')`, to: `values (new.id, 'client', 'pending')` }] },
    'status vem do metadado do usuário': {
      fn: [{ from: `values (new.id, 'client', 'active')`, to: `values (new.id, 'client', coalesce(new.raw_user_meta_data ->> 'status', 'active'))` }],
    },
    'o trigger não existe': { trigger: 'none' },
    'o trigger dispara só no UPDATE': { trigger: [{ from: 'after insert on', to: 'after update on' }] },
  }
  test.each(Object.entries(mutants))('mutante: %s', async (_name, m) => {
    const target = await buildNewUserCopy(m.fn ?? [], m.trigger ?? [])
    await mustFailAnAssertion(assertNewUserIsClientActive(db, target))
  })
})

describe('restrict_update_columns em profiles: o teste "não altera o próprio role" pega cada defeito', () => {
  test('baseline (sem defeito) passa', async () => {
    await buildGuardCopy([], [])
    await assertRoleAndStatusAreFrozen(db, 'pg_temp.profiles_t')
  })

  const mutants: Record<string, { fn?: Edit[]; trigger?: Edit[] | 'none' }> = {
    'role entra na lista permitida': { trigger: [{ from: `('full_name', 'phone'`, to: `('role', 'full_name', 'phone'` }] },
    'status entra na lista permitida': { trigger: [{ from: `('full_name', 'phone'`, to: `('status', 'full_name', 'phone'` }] },
    'id entra na lista permitida': { trigger: [{ from: `('full_name', 'phone'`, to: `('id', 'full_name', 'phone'` }] },
    'o trigger não existe': { trigger: 'none' },
    'o guard ignora todo mundo (early return)': {
      fn: [{ from: `if current_user not in ('anon', 'authenticated') then`, to: `if true then` }],
    },
    'o guard trata todo mundo como admin': { fn: [{ from: `if (select public.is_admin()) then`, to: `if true then` }] },
    'o guard inverte o teste de admin: só não-admin passa': { fn: [{ from: `if (select public.is_admin()) then`, to: `if not (select public.is_admin()) then` }] },
    'a válvula do admin quebrada (admin também barrado)': { fn: [{ from: `if (select public.is_admin()) then`, to: `if false then` }] },
    'o guard barra até coluna permitida': { fn: [{ from: `if col <> all (coalesce(tg_argv, '{}'::text[])) then`, to: `if true then` }] },
    'o guard só olha a primeira coluna alterada': {
      fn: [{ from: `raise exception 'column %.% is not writable by this role', tg_table_name, col\n        using errcode = '42501';`, to: `raise exception 'column %.% is not writable by this role', tg_table_name, col\n        using errcode = '42501';\n    end if;\n    exit;\n    if false then` }],
    },
    'o guard erra o código do erro (não é 42501)': { fn: [{ from: `using errcode = '42501'`, to: `using errcode = 'P0001'` }] },
  }
  test.each(Object.entries(mutants))('mutante: %s', async (_name, m) => {
    await buildGuardCopy(m.fn ?? [], m.trigger ?? [])
    await mustFailAnAssertion(assertRoleAndStatusAreFrozen(db, 'pg_temp.profiles_t'))
  })

  test('o fixture tem um admin e um cliente ativos (pré-requisito das asserções)', async () => {
    const r = await asOwner<{ id: string; role: string; status: string }>(db, `select id, role, status from public.profiles where id in ($1, $2)`, [ID.admin, ID.clientA])
    expect(r.map((x) => `${x.role}:${x.status}`).sort()).toEqual(['admin:active', 'client:active'])
  })
})
