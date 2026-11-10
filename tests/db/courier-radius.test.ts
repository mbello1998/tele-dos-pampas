import type { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { connect } from '../../scripts/db/client'
import { ID, FIXTURE_SQL, actAs, asOwner, attempt, type Attempt, type Who } from './rls-helpers'

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 })

let db: Client

const admin: Who = { uid: ID.admin }
const clientA: Who = { uid: ID.clientA }
const merchant1: Who = { uid: ID.merchant1 }
const courierQ1: Who = { uid: ID.courierQ1 } // Quarai, fleet 1
const courierQ2: Who = { uid: ID.courierQ2 } // Quarai, independent
const courierA1: Who = { uid: ID.courierA1 } // Artigas, fleet 2
const pendingCourier: Who = { uid: ID.pendingCourier }
const fleet1: Who = { uid: ID.fleetOwner1 }
const fleet2: Who = { uid: ID.fleetOwner2 }

// Extra couriers of fleet 1, so that "who gets capped" has more than one row to be wrong about.
const X = 'a0000000-0000-4000-8000-000000000101' // radius 2, below any ceiling used here
const Y = 'a0000000-0000-4000-8000-000000000102' // radius null (no preference)
const FIXTURE_COURIERS = [ID.courierQ1, ID.courierQ2, ID.courierA1, ID.pendingCourier, X, Y]
const idList = FIXTURE_COURIERS.map((i) => `'${i}'`).join(',')

beforeAll(async () => {
  db = await connect()
})
afterAll(async () => {
  await db.end()
})
// Isolation: every test runs in a transaction that is always rolled back (the database is shared).
beforeEach(async () => {
  await db.query('begin')
  await db.query(FIXTURE_SQL)
  await db.query(`
    insert into auth.users (id, email) values ('${X}', 'x@rls-fixture.invalid'), ('${Y}', 'y@rls-fixture.invalid');
    insert into public.profiles (id, role, full_name, status, home_city) values
      ('${X}', 'courier', 'Motoboy X', 'active', 'quarai'), ('${Y}', 'courier', 'Motoboy Y', 'active', 'quarai');
    insert into public.couriers (profile_id, vehicle, base_city, fleet_id, status) values
      ('${X}', 'moto', 'quarai', '${ID.fleet1}', 'approved'), ('${Y}', 'moto', 'quarai', '${ID.fleet1}', 'approved');
    update public.couriers set work_radius_km = 2 where profile_id = '${X}';
  `)
})
afterEach(async () => {
  await db.query('rollback')
})

const setFleetMax = (fleet: string, km: number | null) =>
  asOwner(db, `update public.fleets set max_radius_km = $2 where id = $1`, [fleet, km])

const radiusOf = async (courier: string) =>
  (await asOwner<{ work_radius_km: string | null }>(db, `select work_radius_km from public.couriers where profile_id = $1`, [courier]))[0]
    .work_radius_km

const events = (where = 'true') =>
  asOwner<{ courier_id: string; fleet_id: string | null; kind: string; from_value: string | null; to_value: string | null; actor_id: string | null }>(
    db,
    `select courier_id, fleet_id, kind, from_value, to_value, actor_id from public.courier_events
      where courier_id in (${idList}) and ${where} order by id`,
  )

const expectRefusedLoudly = (a: Attempt, code: string, label: string) => {
  expect(a.ok, `${label} should have been refused`).toBe(false)
  if (!a.ok) expect(a.code, `${label}: ${a.message}`).toBe(code)
}

describe('hierarquia do raio', () => {
  test('work_radius_km acima do max_radius_km da frota é rejeitado', async () => {
    await setFleetMax(ID.fleet1, 4)
    // o próprio motoboy tenta; o dono da frota tenta; o admin tenta: o teto vale para todos
    for (const who of [courierQ1, fleet1, admin]) {
      await actAs(db, who)
      const a = await attempt(db, `update public.couriers set work_radius_km = 4.5 where profile_id = $1`, [ID.courierQ1])
      expectRefusedLoudly(a, '23514', `radius above ceiling as ${JSON.stringify(who)}`)
      if (!a.ok) expect(a.message).toMatch(/radius/i)
    }
    expect(await radiusOf(ID.courierQ1)).toBeNull()
    // INSERT também: um motoboy nunca nasce acima do teto
    await actAs(db, 'postgres')
    const ins = await attempt(
      db,
      `insert into public.couriers (profile_id, vehicle, base_city, fleet_id, work_radius_km)
       values ('${ID.clientA}', 'moto', 'quarai', '${ID.fleet1}', 4.5)`,
    )
    expectRefusedLoudly(ins, '23514', 'insert above ceiling')
  })

  test('work_radius_km igual ao máximo da frota é aceito', async () => {
    await setFleetMax(ID.fleet1, 4)
    await actAs(db, courierQ1)
    const a = await attempt(db, `update public.couriers set work_radius_km = 4 where profile_id = $1`, [ID.courierQ1])
    expect(a.ok && a.rowCount).toBe(1)
    expect(await radiusOf(ID.courierQ1)).toBe('4.00')
  })

  test('motoboy autônomo (fleet_id nulo) é limitado só pelo teto global de settings', async () => {
    await asOwner(db, `update public.settings set value = '4' where key = 'service_radius_km'`)
    await actAs(db, courierQ2)
    const over = await attempt(db, `update public.couriers set work_radius_km = 4.5 where profile_id = $1`, [ID.courierQ2])
    expectRefusedLoudly(over, '23514', 'independent above global ceiling')
    const ok = await attempt(db, `update public.couriers set work_radius_km = 4 where profile_id = $1`, [ID.courierQ2])
    expect(ok.ok && ok.rowCount).toBe(1)
  })

  test('a frota também respeita o teto global: max_radius_km acima de service_radius_km é rejeitado', async () => {
    await actAs(db, fleet1) // global = 5
    const over = await attempt(db, `update public.fleets set max_radius_km = 5.5 where id = $1`, [ID.fleet1])
    expectRefusedLoudly(over, '23514', 'fleet max above global ceiling')
    const ok = await attempt(db, `update public.fleets set max_radius_km = 5 where id = $1`, [ID.fleet1])
    expect(ok.ok && ok.rowCount).toBe(1)
  })

  test('o teto de uma frota não limita motoboy de outra nem autônomo', async () => {
    await setFleetMax(ID.fleet1, 2)
    await actAs(db, courierQ2)
    const a = await attempt(db, `update public.couriers set work_radius_km = 5 where profile_id = $1`, [ID.courierQ2])
    expect(a.ok && a.rowCount).toBe(1)
    await actAs(db, courierA1)
    const b = await attempt(db, `update public.couriers set work_radius_km = 5 where profile_id = $1`, [ID.courierA1])
    expect(b.ok && b.rowCount).toBe(1)
  })

  test('trocar de frota para uma com teto menor que o raio do motoboy é rejeitado (ninguém é cortado em silêncio)', async () => {
    await asOwner(db, `update public.couriers set work_radius_km = 5 where profile_id = $1`, [ID.courierQ2])
    await setFleetMax(ID.fleet2, 3)
    await actAs(db, admin)
    const a = await attempt(db, `update public.couriers set fleet_id = $2 where profile_id = $1`, [ID.courierQ2, ID.fleet2])
    expectRefusedLoudly(a, '23514', 'move into a fleet with a lower ceiling')
    // abaixando o raio antes, a troca passa
    await asOwner(db, `update public.couriers set work_radius_km = 3 where profile_id = $1`, [ID.courierQ2])
    await actAs(db, admin)
    const b = await attempt(db, `update public.couriers set fleet_id = $2 where profile_id = $1`, [ID.courierQ2, ID.fleet2])
    expect(b.ok && b.rowCount).toBe(1)
  })

  test('um update sem relação com o raio não é barrado por um raio antigo acima do teto', async () => {
    await asOwner(db, `update public.couriers set work_radius_km = 5 where profile_id = $1`, [ID.courierQ2])
    await asOwner(db, `update public.settings set value = '4' where key = 'service_radius_km'`) // o admin baixou o teto global
    await actAs(db, courierQ2)
    const a = await attempt(db, `update public.couriers set is_online = true where profile_id = $1`, [ID.courierQ2])
    expect(a.ok && a.rowCount).toBe(1)
  })

  test('dono reduzindo max_radius_km ajusta para baixo os motoboys acima do novo teto', async () => {
    await setFleetMax(ID.fleet1, 5)
    await asOwner(db, `update public.couriers set work_radius_km = 5 where profile_id = $1`, [ID.courierQ1])
    await asOwner(db, `update public.couriers set work_radius_km = 4 where profile_id = $1`, [ID.courierA1])
    await asOwner(db, `update public.couriers set work_radius_km = 5 where profile_id = $1`, [ID.courierQ2])

    // o dono real, pela API, na mesma instrução
    await actAs(db, fleet1)
    const a = await attempt(db, `update public.fleets set max_radius_km = 3 where id = $1`, [ID.fleet1])
    expect(a.ok && a.rowCount).toBe(1)

    expect(await radiusOf(ID.courierQ1)).toBe('3.00') // estava acima: descido
    expect(await radiusOf(X)).toBe('2.00') // abaixo do novo teto: intocado
    expect(await radiusOf(Y)).toBeNull() // sem preferência: continua sem
    expect(await radiusOf(ID.courierA1)).toBe('4.00') // outra frota: intocado
    expect(await radiusOf(ID.courierQ2)).toBe('5.00') // autônomo: intocado
  })

  test('reduzir de um teto vazio (nulo) para um número também ajusta, e aumentar o teto não mexe em ninguém', async () => {
    await asOwner(db, `update public.couriers set work_radius_km = 5 where profile_id = $1`, [ID.courierQ1])
    await setFleetMax(ID.fleet1, 3) // era nulo
    expect(await radiusOf(ID.courierQ1)).toBe('3.00')
    await setFleetMax(ID.fleet1, 5) // subir
    expect(await radiusOf(ID.courierQ1)).toBe('3.00')
  })

  test('cada ajuste forçado gera courier_events com kind capped_by_fleet', async () => {
    await setFleetMax(ID.fleet1, 5)
    await asOwner(db, `update public.couriers set work_radius_km = 5 where profile_id in ('${ID.courierQ1}')`)
    await asOwner(db, `update public.couriers set work_radius_km = 4 where profile_id = '${X}'`)
    const before = (await events()).length

    await actAs(db, fleet1)
    await db.query(`update public.fleets set max_radius_km = 3 where id = '${ID.fleet1}'`)

    const e = (await events()).slice(before)
    // Q1 (5 -> 3) e X (4 -> 3) foram cortados, cada um exatamente uma vez; Y (nulo) fica de fora
    expect(e.map((r) => [r.courier_id, r.kind, r.from_value, r.to_value]).sort()).toEqual(
      [
        [ID.courierQ1, 'capped_by_fleet', '5.00', '3.00'],
        [X, 'capped_by_fleet', '4.00', '3.00'],
      ].sort(),
    )
    for (const r of e) {
      expect(r.fleet_id).toBe(ID.fleet1)
      expect(r.actor_id).toBe(ID.fleetOwner1) // quem baixou o teto, visível ao dono
    }
    // e nenhum radius_changed duplicado pelo mesmo ajuste
    expect(e.filter((r) => r.kind === 'radius_changed')).toEqual([])
  })

  test('um motoboy abaixo do novo teto não gera evento nenhum', async () => {
    await actAs(db, fleet1)
    await db.query(`update public.fleets set max_radius_km = 3 where id = '${ID.fleet1}'`)
    expect(await events(`kind = 'capped_by_fleet'`)).toEqual([]) // X(2), Y(null), Q1(null) estão dentro
  })
})

describe('courier_events: o que gera evento', () => {
  test('mudar work_radius_km gera courier_events radius_changed com from_value e to_value', async () => {
    await actAs(db, courierQ1)
    await db.query(`update public.couriers set work_radius_km = 3 where profile_id = '${ID.courierQ1}'`)
    await db.query(`update public.couriers set work_radius_km = 4.5 where profile_id = '${ID.courierQ1}'`)
    const e = await events(`courier_id = '${ID.courierQ1}'`)
    expect(e.map((r) => [r.kind, r.from_value, r.to_value])).toEqual([
      ['radius_changed', null, '3.00'],
      ['radius_changed', '3.00', '4.50'],
    ])
    expect(e.every((r) => r.actor_id === ID.courierQ1 && r.fleet_id === ID.fleet1)).toBe(true)
  })

  test('is_online de false para true gera went_online; o inverso gera went_offline', async () => {
    await actAs(db, courierQ1)
    await db.query(`update public.couriers set is_online = true where profile_id = '${ID.courierQ1}'`)
    await db.query(`update public.couriers set is_online = false where profile_id = '${ID.courierQ1}'`)
    const e = await events(`courier_id = '${ID.courierQ1}'`)
    expect(e.map((r) => [r.kind, r.from_value, r.to_value])).toEqual([
      ['went_online', 'false', 'true'],
      ['went_offline', 'true', 'false'],
    ])
  })

  test('is_available gera became_available e became_busy', async () => {
    await actAs(db, courierQ1)
    await db.query(`update public.couriers set is_available = false where profile_id = '${ID.courierQ1}'`)
    await db.query(`update public.couriers set is_available = true where profile_id = '${ID.courierQ1}'`)
    const e = await events(`courier_id = '${ID.courierQ1}'`)
    expect(e.map((r) => [r.kind, r.from_value, r.to_value])).toEqual([
      ['became_busy', 'true', 'false'],
      ['became_available', 'false', 'true'],
    ])
  })

  test('uma única instrução que muda vários campos gera um evento por campo; um no-op não gera nenhum', async () => {
    await actAs(db, courierQ1)
    await db.query(
      `update public.couriers set is_online = true, is_available = false, work_radius_km = 2 where profile_id = '${ID.courierQ1}'`,
    )
    expect((await events(`courier_id = '${ID.courierQ1}'`)).map((r) => r.kind).sort()).toEqual([
      'became_busy',
      'radius_changed',
      'went_online',
    ])
    const n = (await events()).length
    await db.query(
      `update public.couriers set is_online = true, is_available = false, work_radius_km = 2, plate = 'ABC1D23' where profile_id = '${ID.courierQ1}'`,
    )
    expect((await events()).length).toBe(n)
  })

  test('nascer já online, ocupado ou com raio também deixa rastro (INSERT)', async () => {
    const Z = 'a0000000-0000-4000-8000-000000000103'
    await asOwner(
      db,
      `insert into auth.users (id, email) values ('${Z}', 'z@rls-fixture.invalid');
       insert into public.profiles (id, role, full_name, status, home_city) values ('${Z}', 'courier', 'Z', 'active', 'quarai');
       insert into public.couriers (profile_id, vehicle, base_city, is_online, is_available, work_radius_km)
         values ('${Z}', 'moto', 'quarai', true, false, 2)`,
    )
    const r = await asOwner<{ kind: string }>(db, `select kind from public.courier_events where courier_id = $1 order by kind`, [Z])
    expect(r.map((x) => x.kind)).toEqual(['became_busy', 'radius_changed', 'went_online'])
  })

  test('courier_events grava fleet_id no momento do evento, e o histórico sobrevive à troca de frota', async () => {
    await actAs(db, courierQ1)
    await db.query(`update public.couriers set is_online = true where profile_id = '${ID.courierQ1}'`) // na frota 1
    await actAs(db, admin)
    await db.query(`update public.couriers set fleet_id = '${ID.fleet2}' where profile_id = '${ID.courierQ1}'`)
    await actAs(db, courierQ1)
    await db.query(`update public.couriers set is_online = false where profile_id = '${ID.courierQ1}'`) // na frota 2

    const e = await events(`courier_id = '${ID.courierQ1}'`)
    expect(e.map((r) => [r.kind, r.fleet_id])).toEqual([
      ['went_online', ID.fleet1], // continua apontando para a frota de então
      ['went_offline', ID.fleet2],
    ])
    // cada dono enxerga só o trecho do próprio tempo
    const seen = async (who: Who) => {
      await actAs(db, who)
      return (await db.query(`select kind from public.courier_events where courier_id = '${ID.courierQ1}' order by id`)).rows.map(
        (r) => r.kind,
      )
    }
    expect(await seen(fleet1)).toEqual(['went_online'])
    expect(await seen(fleet2)).toEqual(['went_offline'])
  })

  test('os toggles operacionais continuam fora do audit_log, mas o raio entra nele', async () => {
    const audits = async () =>
      (
        await asOwner<{ n: number }>(
          db,
          `select count(*)::int n from public.audit_log where table_name = 'couriers' and record_id = $1 and action = 'UPDATE'`,
          [ID.courierQ1],
        )
      )[0].n
    const n0 = await audits()
    await actAs(db, courierQ1)
    await db.query(`update public.couriers set is_online = true, is_available = false where profile_id = '${ID.courierQ1}'`)
    expect(await audits()).toBe(n0)
    await actAs(db, courierQ1)
    await db.query(`update public.couriers set work_radius_km = 3 where profile_id = '${ID.courierQ1}'`)
    expect(await audits()).toBe(n0 + 1)
  })
})

describe('allowlist de colunas (restrict_update_columns)', () => {
  test('o motoboy edita work_radius_km e is_available; o dono da frota edita max_radius_km', async () => {
    await actAs(db, courierQ1)
    const a = await attempt(db, `update public.couriers set work_radius_km = 3, is_available = false where profile_id = $1`, [ID.courierQ1])
    expect(a.ok && a.rowCount, a.ok ? '' : a.message).toBe(1)
    await actAs(db, fleet1)
    const b = await attempt(db, `update public.fleets set max_radius_km = 4 where id = $1`, [ID.fleet1])
    expect(b.ok && b.rowCount, b.ok ? '' : b.message).toBe(1)
    expect((await asOwner(db, `select max_radius_km from public.fleets where id = $1`, [ID.fleet1]))[0].max_radius_km).toBe('4.00')
  })

  test('o allowlist continua fechado para o resto: o motoboy não muda fleet_id nem status, a frota não muda status', async () => {
    await actAs(db, courierQ1)
    expectRefusedLoudly(await attempt(db, `update public.couriers set fleet_id = null where profile_id = $1`, [ID.courierQ1]), '42501', 'fleet_id')
    expectRefusedLoudly(await attempt(db, `update public.couriers set status = 'suspended', work_radius_km = 1 where profile_id = $1`, [ID.courierQ1]), '42501', 'status with radius')
    await actAs(db, fleet1)
    expectRefusedLoudly(await attempt(db, `update public.fleets set status = 'suspended', max_radius_km = 2 where id = $1`, [ID.fleet1]), '42501', 'fleet status')
  })

  test('as colunas antigas do allowlist continuam editáveis (não se perdeu nada na troca do trigger)', async () => {
    await actAs(db, courierQ1)
    const a = await attempt(
      db,
      `update public.couriers set vehicle = 'bike', plate = 'ZZZ', accepts_cross_border = true, accepts_passenger = true, is_online = true where profile_id = $1`,
      [ID.courierQ1],
    )
    expect(a.ok && a.rowCount).toBe(1)
    await actAs(db, fleet1)
    const b = await attempt(db, `update public.fleets set name = 'Nova', phone = '55' where id = $1`, [ID.fleet1])
    expect(b.ok && b.rowCount).toBe(1)
  })

  test('um motoboy não altera o raio de outro, e uma frota não altera o teto nem o motoboy de outra', async () => {
    await actAs(db, courierQ2)
    const a = await attempt(db, `update public.couriers set work_radius_km = 1 where profile_id = $1`, [ID.courierQ1])
    expect(a.ok ? a.rowCount : 0).toBe(0)
    await actAs(db, fleet2)
    const b = await attempt(db, `update public.fleets set max_radius_km = 1 where id = $1`, [ID.fleet1])
    expect(b.ok ? b.rowCount : 0).toBe(0)
    const c = await attempt(db, `update public.couriers set work_radius_km = 1 where profile_id = $1`, [ID.courierQ1])
    expect(c.ok ? c.rowCount : 0).toBe(0)
    expect(await radiusOf(ID.courierQ1)).toBeNull()
  })
})

describe('courier_events: acesso', () => {
  // um evento por motoboy, gerado pelo trigger (nunca inserido à mão)
  beforeEach(async () => {
    await asOwner(
      db,
      `update public.couriers set is_online = true where profile_id in ('${ID.courierQ1}', '${ID.courierQ2}', '${ID.courierA1}', '${ID.pendingCourier}')`,
    )
  })

  // X (fleet 1) also has an event, from the radius it was given in setup: the four below are the ones under test
  const four = [ID.courierQ1, ID.courierQ2, ID.courierA1, ID.pendingCourier].map((i) => `'${i}'`).join(',')
  const read = async (who: Who) => {
    await actAs(db, who)
    const r = await db.query<{ courier_id: string }>(
      `select courier_id from public.courier_events where courier_id in (${four}) order by courier_id`,
    )
    return r.rows.map((x) => x.courier_id)
  }

  test('courier_events não é gravável pela aplicação, só pelo trigger', async () => {
    const row = `insert into public.courier_events (courier_id, fleet_id, kind) values ('${ID.courierQ1}', '${ID.fleet1}', 'went_online')`
    for (const who of [courierQ1, fleet1, admin, clientA, merchant1, 'anon' as const]) {
      await actAs(db, who)
      expectRefusedLoudly(await attempt(db, row), '42501', `insert as ${JSON.stringify(who)}`)
    }
    // o trigger, esse sim, escreve mesmo quando quem altera é um papel sem nenhum privilégio de escrita na tabela
    const n = (await events()).length
    await actAs(db, courierQ1)
    await db.query(`update public.couriers set is_available = false where profile_id = '${ID.courierQ1}'`)
    expect((await events()).length).toBe(n + 1)
  })

  test('fleet lê courier_events dos motoboys da própria frota', async () => {
    expect(await read(fleet1)).toEqual([ID.courierQ1].sort())
    // and the fleet owner does see X's radius event: it is theirs
    await actAs(db, fleet1)
    expect((await db.query(`select 1 from public.courier_events where courier_id = '${X}'`)).rowCount).toBe(1)
    expect(await read(fleet2)).toEqual([ID.courierA1].sort())
  })

  test('fleet NÃO lê courier_events de motoboy de outra frota nem de autônomo', async () => {
    const seen = await read(fleet1)
    expect(seen).not.toContain(ID.courierA1)
    expect(seen).not.toContain(ID.courierQ2)
    expect(await read(fleet2)).not.toContain(ID.courierQ1)
  })

  test('courier lê os próprios courier_events e NÃO os de outro', async () => {
    expect(await read(courierQ1)).toEqual([ID.courierQ1])
    expect(await read(courierQ2)).toEqual([ID.courierQ2])
    expect(await read(courierA1)).toEqual([ID.courierA1])
  })

  test('admin lê todos', async () => {
    expect(await read(admin)).toEqual([ID.courierQ1, ID.courierQ2, ID.courierA1, ID.pendingCourier].sort())
  })

  test('client e merchant NÃO leem courier_events; anônimo nem a tabela; perfil pendente não lê nada', async () => {
    expect(await read(clientA)).toEqual([])
    expect(await read(merchant1)).toEqual([])
    expect(await read(pendingCourier)).toEqual([]) // app_role() é nulo: sem privilégio nenhum, nem sobre o próprio histórico
    await actAs(db, 'anon')
    expectRefusedLoudly(await attempt(db, `select * from public.courier_events`), '42501', 'anon select')
  })

  test('um dono de frota suspenso ou pendente não lê o feed', async () => {
    await asOwner(db, `update public.fleets set status = 'suspended' where id = '${ID.fleet1}'`)
    expect(await read(fleet1)).toEqual([])
  })

  test('ninguém, nem admin, altera ou apaga courier_events', async () => {
    for (const who of [courierQ1, fleet1, admin, clientA, merchant1]) {
      await actAs(db, who)
      expectRefusedLoudly(await attempt(db, `update public.courier_events set kind = 'went_offline'`), '42501', `update as ${JSON.stringify(who)}`)
      expectRefusedLoudly(await attempt(db, `delete from public.courier_events`), '42501', `delete as ${JSON.stringify(who)}`)
      expectRefusedLoudly(await attempt(db, `truncate public.courier_events`), '42501', `truncate as ${JSON.stringify(who)}`)
    }
    expect((await events(`courier_id in (${four})`)).length).toBe(4)
  })

  test('a tabela tem RLS ligado e nenhuma policy de escrita', async () => {
    const t = await asOwner<{ relrowsecurity: boolean }>(db, `select relrowsecurity from pg_class where oid = 'public.courier_events'::regclass`)
    expect(t[0].relrowsecurity).toBe(true)
    const p = await asOwner<{ cmd: string }>(db, `select cmd from pg_policies where schemaname = 'public' and tablename = 'courier_events'`)
    expect(p.length).toBeGreaterThanOrEqual(3)
    expect(p.every((x) => x.cmd === 'SELECT')).toBe(true)
  })
})

describe('raio efetivo', () => {
  test('effective_radius_km é o menor entre o raio do motoboy, o teto da frota e o teto global (nulo = sem preferência)', async () => {
    const eff = async (c: string) =>
      Number((await asOwner<{ r: string }>(db, `select private.effective_radius_km($1) as r`, [c]))[0].r)
    expect(await eff(ID.courierQ2)).toBe(5) // autônomo sem preferência: o teto global
    await setFleetMax(ID.fleet1, 4)
    expect(await eff(ID.courierQ1)).toBe(4) // sem preferência: o teto da frota
    expect(await eff(X)).toBe(2) // preferência abaixo do teto
    await asOwner(db, `update public.settings set value = '3' where key = 'service_radius_km'`)
    expect(await eff(ID.courierQ1)).toBe(3) // o teto global baixou depois: vale o menor
  })
})
