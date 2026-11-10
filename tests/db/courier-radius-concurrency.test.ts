import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { connect } from '../../scripts/db/client'
import { actAs } from './rls-helpers'

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 })

/**
 * The invariant: no courier ever ends up above the fleet's maximum, whichever order a courier raising its
 * radius and an owner lowering the maximum land in. This needs two live connections, so it CANNOT run inside
 * the usual rolled-back transaction: the second session would never see the first one's uncommitted rows.
 * It therefore creates its own committed rows under a private id prefix and deletes them again (and only them)
 * in afterAll, and also in beforeAll in case an earlier run was killed halfway. The shared data is not touched.
 *
 * The interleavings are forced, not hoped for: the blocked statement is observed waiting on a lock in
 * pg_stat_activity before the other transaction is allowed to commit.
 */
const id = (n: number) => `e5b00000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const IDS = {
  // scenario A: the owner's UPDATE lands first and is still uncommitted when the courier tries to raise
  ownerA: id(1), fleetA: id(2), courierA: id(3),
  // scenario B: the courier's UPDATE lands first and is still uncommitted when the owner lowers the maximum
  ownerB: id(4), fleetB: id(5), courierB: id(6),
}
const ALL = Object.values(IDS)

let admin: Client // autocommit: setup, observation, cleanup
let owner: Client
let courier: Client

const cleanup = async () => {
  await admin.query(`delete from public.courier_events where courier_id = any($1::uuid[])`, [ALL])
  await admin.query(`delete from public.couriers where profile_id = any($1::uuid[])`, [ALL])
  await admin.query(`delete from public.fleets where id = any($1::uuid[])`, [ALL])
  // the audit triggers on couriers/profiles wrote rows for these ids: they are ours, remove them too
  await admin.query(`delete from public.audit_log where record_id = any($1::text[])`, [ALL])
  await admin.query(`delete from public.profiles where id = any($1::uuid[])`, [ALL])
  await admin.query(`delete from public.audit_log where record_id = any($1::text[])`, [ALL])
  await admin.query(`delete from auth.users where id = any($1::uuid[])`, [ALL])
}

const setup = async () => {
  await cleanup()
  await admin.query(
    `insert into auth.users (id, email) values
       ('${IDS.ownerA}', 'owner-a@concurrency.invalid'), ('${IDS.courierA}', 'courier-a@concurrency.invalid'),
       ('${IDS.ownerB}', 'owner-b@concurrency.invalid'), ('${IDS.courierB}', 'courier-b@concurrency.invalid');
     insert into public.profiles (id, role, full_name, status, home_city) values
       ('${IDS.ownerA}', 'fleet', 'Owner A', 'active', 'quarai'), ('${IDS.courierA}', 'courier', 'Courier A', 'active', 'quarai'),
       ('${IDS.ownerB}', 'fleet', 'Owner B', 'active', 'quarai'), ('${IDS.courierB}', 'courier', 'Courier B', 'active', 'quarai')
     on conflict (id) do update set role = excluded.role, full_name = excluded.full_name, status = excluded.status, home_city = excluded.home_city;
     insert into public.fleets (id, owner_id, name, city, status, max_radius_km) values
       ('${IDS.fleetA}', '${IDS.ownerA}', 'Concurrency A', 'quarai', 'approved', 5),
       ('${IDS.fleetB}', '${IDS.ownerB}', 'Concurrency B', 'quarai', 'approved', 5);
     insert into public.couriers (profile_id, vehicle, base_city, fleet_id, status) values
       ('${IDS.courierA}', 'moto', 'quarai', '${IDS.fleetA}', 'approved'),
       ('${IDS.courierB}', 'moto', 'quarai', '${IDS.fleetB}', 'approved');`,
  )
}

/** Wait until the backend of `client` is blocked on a lock (so the interleaving is really the one we want). */
const pidOf = async (client: Client) => (await client.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0].pid

// The pid must be read BEFORE the statement is started: a pg client queues queries, so asking the blocked
// client for it afterwards would wait behind the very statement we are observing.
const waitUntilBlocked = async (pid: number) => {
  for (let i = 0; i < 100; i++) {
    const r = await admin.query(
      `select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`,
      [pid],
    )
    if (r.rowCount) return
    await new Promise((res) => setTimeout(res, 100))
  }
  throw new Error('the second statement never blocked: the interleaving this test needs did not happen')
}

/** Start a statement without awaiting it; never rejects, resolves to ok or the error. */
const start = (client: Client, sql: string) =>
  client.query(sql).then(
    () => ({ ok: true as const }),
    (e: { code?: string; message: string }) => ({ ok: false as const, code: e.code, message: e.message }),
  )

beforeAll(async () => {
  admin = await connect()
  owner = await connect()
  courier = await connect()
  await setup()
})
afterAll(async () => {
  try {
    await owner.query('rollback').catch(() => undefined)
    await courier.query('rollback').catch(() => undefined)
    await cleanup()
  } finally {
    await Promise.all([admin.end(), owner.end(), courier.end()])
  }
})

describe('raio: concorrência entre o motoboy e o dono da frota', () => {
  test('o dono baixa o teto (ainda sem commit) e o motoboy tenta subir ao teto antigo: o motoboy espera e é recusado', async () => {
    await owner.query('begin')
    await actAs(owner, { uid: IDS.ownerA })
    await owner.query(`update public.fleets set max_radius_km = 3 where id = '${IDS.fleetA}'`) // uncommitted, holds the row

    await courier.query('begin')
    await actAs(courier, { uid: IDS.courierA })
    const courierPid = await pidOf(courier)
    const raising = start(courier, `update public.couriers set work_radius_km = 5 where profile_id = '${IDS.courierA}'`)
    await waitUntilBlocked(courierPid) // without FOR SHARE it would NOT block: it would read the stale maximum 5 and succeed

    await owner.query('commit')
    const r = await raising
    await courier.query('rollback')

    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('23514')
    const row = (
      await admin.query(
        `select c.work_radius_km, f.max_radius_km from public.couriers c join public.fleets f on f.id = c.fleet_id where c.profile_id = $1`,
        [IDS.courierA],
      )
    ).rows[0]
    expect(row.max_radius_km).toBe('3.00')
    expect(Number(row.work_radius_km ?? 0)).toBeLessThanOrEqual(3)
  })

  test('o motoboy sobe o raio (ainda sem commit) e o dono baixa o teto: o dono espera e o ajuste pega o valor novo', async () => {
    await courier.query('begin')
    await actAs(courier, { uid: IDS.courierB })
    await courier.query(`update public.couriers set work_radius_km = 5 where profile_id = '${IDS.courierB}'`) // passes: max is 5

    await owner.query('begin')
    await actAs(owner, { uid: IDS.ownerB })
    const ownerPid = await pidOf(owner)
    const lowering = start(owner, `update public.fleets set max_radius_km = 3 where id = '${IDS.fleetB}'`)
    await waitUntilBlocked(ownerPid) // the courier's FOR SHARE on the fleet row is still held

    await courier.query('commit')
    const r = await lowering
    expect(r.ok, r.ok ? '' : r.message).toBe(true)
    await owner.query('commit')

    const row = (
      await admin.query(
        `select c.work_radius_km, f.max_radius_km from public.couriers c join public.fleets f on f.id = c.fleet_id where c.profile_id = $1`,
        [IDS.courierB],
      )
    ).rows[0]
    expect(row.max_radius_km).toBe('3.00')
    expect(row.work_radius_km).toBe('3.00') // came down from 5: nobody above the ceiling
    const kinds = (
      await admin.query(`select kind, from_value, to_value from public.courier_events where courier_id = $1 order by id`, [IDS.courierB])
    ).rows
    expect(kinds).toEqual([
      { kind: 'radius_changed', from_value: null, to_value: '5.00' },
      { kind: 'capped_by_fleet', from_value: '5.00', to_value: '3.00' },
    ])
  })

  test('invariante final: nenhum dos motoboys criados aqui ficou acima do teto da própria frota', async () => {
    const r = await admin.query(
      `select count(*)::int as n from public.couriers c join public.fleets f on f.id = c.fleet_id
        where c.profile_id = any($1::uuid[]) and c.work_radius_km > f.max_radius_km`,
      [ALL],
    )
    expect(r.rows[0].n).toBe(0)
  })
})
