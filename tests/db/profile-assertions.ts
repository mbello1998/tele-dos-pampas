import { expect } from 'vitest'
import type { Client } from 'pg'
import { actAs, asOwner, attempt, ID } from './rls-helpers'

/**
 * Assertions about profile creation and the role guard, written once and run twice:
 *   - tests/db/profile.test.ts runs them against the LIVE objects (auth.users trigger, public.profiles);
 *   - tests/db/profile-mutants.test.ts runs the SAME functions against TEMP copies rebuilt from the
 *     migration text with one deliberate defect each, and requires them to FAIL.
 * A guard whose test passes when the guard is broken is no guard; the second run is what proves these discriminate.
 */

export type NewUserTarget = {
  /** Creates an auth user (the way GoTrue does: an INSERT into auth.users) and lets the trigger fire. */
  createUser(db: Client, id: string, meta: Record<string, unknown>): Promise<void>
  readProfile(db: Client, id: string): Promise<{ role: string; status: string } | undefined>
}

export const liveNewUser: NewUserTarget = {
  async createUser(db, id, meta) {
    await asOwner(
      db,
      `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`,
      [id, `${id}@profile-test.invalid`, JSON.stringify(meta)],
    )
  },
  async readProfile(db, id) {
    return (await asOwner<{ role: string; status: string }>(db, `select role, status from public.profiles where id = $1`, [id]))[0]
  },
}

const NEW_ID = 'a0000000-0000-4000-8000-0000000000a1'
const HOSTILE_ID = 'a0000000-0000-4000-8000-0000000000a2'

/** A new account is a plain, active client, whatever the sign-up request tried to say about itself. */
export async function assertNewUserIsClientActive(db: Client, target: NewUserTarget) {
  await target.createUser(db, NEW_ID, {})
  expect(await target.readProfile(db, NEW_ID)).toEqual({ role: 'client', status: 'active' })

  // user_metadata is chosen by the person signing up (signInWithOtp options.data). Nothing in it may become a privilege.
  await target.createUser(db, HOSTILE_ID, { role: 'admin', status: 'blocked', user_role: 'admin', is_admin: true, app_role: 'admin' })
  expect(await target.readProfile(db, HOSTILE_ID)).toEqual({ role: 'client', status: 'active' })
}

/**
 * `table` holds the actor's own row (id = ID.clientA). The actor is impersonated exactly as PostgREST does.
 * Expected: role, status and id are refused with 42501 and nothing changes; an allowlisted column still updates
 * (so "refuse every update" cannot pass); an admin can still change another user's role (the designed valve).
 */
export async function assertRoleAndStatusAreFrozen(db: Client, table: string) {
  const actor = { uid: ID.clientA }
  const row = async () => (await asOwner<{ role: string; status: string; full_name: string | null }>(db, `select role, status, full_name from ${table} where id = $1`, [ID.clientA]))[0]
  const before = await row()
  expect(before).toMatchObject({ role: 'client', status: 'active' })

  for (const set of [`role = 'admin'`, `role = 'courier'`, `status = 'pending'`, `status = 'blocked'`, `id = '${ID.clientB}'`]) {
    await actAs(db, actor)
    const a = await attempt(db, `update ${table} set ${set} where id = $1`, [ID.clientA])
    expect(a.ok, `${set} must be refused`).toBe(false)
    if (!a.ok) expect(a.code, set).toBe('42501')
    expect(await row(), `${set} must change nothing`).toEqual(before)
  }

  // two columns in one statement: a legitimate one cannot smuggle a forbidden one
  await actAs(db, actor)
  const mixed = await attempt(db, `update ${table} set full_name = 'Smuggled', role = 'admin' where id = $1`, [ID.clientA])
  expect(mixed.ok).toBe(false)
  expect((await row()).full_name).toBe(before.full_name)

  // the same, with the forbidden column sorting AFTER the allowed one in the row's JSON (a guard that only
  // inspects the first changed column would let this through)
  await actAs(db, actor)
  const late = await attempt(db, `update ${table} set full_name = 'Smuggled', created_at = now() - interval '1 day' where id = $1`, [ID.clientA])
  expect(late.ok).toBe(false)
  expect((await row()).full_name).toBe(before.full_name)

  // an allowlisted column still works
  await actAs(db, actor)
  const fine = await attempt(db, `update ${table} set full_name = 'Novo Nome' where id = $1`, [ID.clientA])
  expect(fine.ok && fine.rowCount).toBe(1)
  expect((await row()).full_name).toBe('Novo Nome')

  // the admin valve: an active admin may change someone else's role (approving a courier, for instance)
  await actAs(db, { uid: ID.admin })
  const viaAdmin = await attempt(db, `update ${table} set role = 'courier' where id = $1`, [ID.clientA])
  expect(viaAdmin.ok && viaAdmin.rowCount).toBe(1)
  expect((await row()).role).toBe('courier')
}
