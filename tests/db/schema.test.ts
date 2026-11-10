import type { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test } from 'vitest'
import { connect } from '../../scripts/db/client'

let db: Client

beforeAll(async () => {
  db = await connect()
})
afterAll(async () => {
  await db.end()
})
// Isolation: every test runs inside a transaction that is always rolled back.
beforeEach(async () => {
  await db.query('begin')
})
afterEach(async () => {
  await db.query('rollback')
})

const SPEC_TABLES = [
  'profiles', 'merchants', 'merchant_hours', 'couriers', 'fleets',
  'catalog_categories', 'catalog_items', 'item_option_groups', 'item_options',
  'addresses', 'zones',
  'orders', 'order_items', 'order_events', 'courier_positions',
  'pricing_rules', 'fx_rates', 'settings', 'audit_log', 'status_transitions',
]

describe('schema', () => {
  test('todas as tabelas da spec existem', async () => {
    const { rows } = await db.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public'`,
    )
    const have = rows.map((r) => r.tablename)
    for (const t of SPEC_TABLES) expect(have, t).toContain(t)
  })

  test('todo valor monetário é numeric, nenhum é float ou double', async () => {
    const floats = await db.query(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and data_type in ('real', 'double precision')`,
    )
    expect(floats.rows).toEqual([])

    const money = await db.query<{ table_name: string; column_name: string; data_type: string; p: number; s: number }>(
      `select table_name, column_name, data_type, numeric_precision as p, numeric_scale as s
       from information_schema.columns
       where table_schema = 'public'
         and (column_name like '%\_brl' escape '\' or column_name like '%\_brl\_snapshot' escape '\'
              or column_name in ('total_charged', 'change_for', 'line_total_brl'))`,
    )
    expect(money.rows.length).toBeGreaterThan(10)
    for (const r of money.rows) {
      expect(`${r.table_name}.${r.column_name} ${r.data_type}(${r.p},${r.s})`).toMatch(/ numeric\(10,2\)$/)
    }
  })

  test('RLS está habilitada em TODAS as tabelas públicas', async () => {
    const all = await db.query(`select count(*)::int as n from pg_tables where schemaname = 'public'`)
    expect(all.rows[0].n).toBeGreaterThanOrEqual(SPEC_TABLES.length)
    const { rows } = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity`,
    )
    expect(rows).toEqual([])
  })

  test('profiles.role é enum e profiles.phone é nulável', async () => {
    const { rows } = await db.query(
      `select column_name, data_type, udt_name, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'profiles' and column_name in ('role', 'phone')`,
    )
    const by = Object.fromEntries(rows.map((r) => [r.column_name, r]))
    expect(by.role.data_type).toBe('USER-DEFINED')
    expect(by.role.udt_name).toBe('user_role')
    expect(by.phone.is_nullable).toBe('YES')
  })
})

describe('seeds', () => {
  test('seed carrega as 7 transições de food, 5 de courier e 5 de ride', async () => {
    const { rows } = await db.query<{ kind: string; n: number }>(
      `select kind::text, count(*)::int as n from status_transitions group by kind`,
    )
    const by = Object.fromEntries(rows.map((r) => [r.kind, r.n]))
    expect(by).toEqual({ food: 7, courier: 5, ride: 5 })
  })

  test('pricing_rules padrão tem base 10.00, included_km 2.0, per_km 2.50, min 10.00', async () => {
    const { rows } = await db.query(`select * from pricing_rules where valid_to is null`)
    expect(rows.length).toBe(6)
    for (const r of rows) {
      expect(r.base_fare_brl).toBe('10.00')
      expect(Number(r.included_km)).toBe(2)
      expect(r.per_km_brl).toBe('2.50')
      expect(r.min_fare_brl).toBe('10.00')
      expect(r.night_surcharge_brl).toBe('3.00')
      expect(r.night_from).toBe('23:00:00')
      expect(r.night_to).toBe('05:00:00')
      expect(r.cross_border_fee_brl).toBe('8.00')
      expect(r.passenger_cross_border_fee_brl).toBe('12.00')
    }
  })

  test('settings e dois merchants de exemplo (trailer em Quaraí, restaurante em Artigas)', async () => {
    const m = await db.query(`select kind::text, city, country from merchants order by country`)
    expect(m.rows).toEqual([
      { kind: 'trailer', city: 'Quaraí', country: 'BR' },
      { kind: 'restaurante', city: 'Artigas', country: 'UY' },
    ])
    const s = await db.query(`select count(*)::int as n from settings`)
    expect(s.rows[0].n).toBeGreaterThan(0)
  })

  test('pricing_rules não permite duas versões vigentes para a mesma cidade e kind', async () => {
    await db.query('savepoint sp')
    await expect(
      db.query(
        `insert into pricing_rules (city, kind, base_fare_brl, included_km, per_km_brl, min_fare_brl,
           night_surcharge_brl, night_from, night_to, cross_border_fee_brl, passenger_cross_border_fee_brl, valid_from)
         values ('Quaraí', 'food', 11, 2, 2.5, 10, 3, '23:00', '05:00', 8, 12, current_date)`,
      ),
    ).rejects.toMatchObject({ code: '23P01' })
    await db.query('rollback to savepoint sp')

    // a new version that starts after the old one is closed is allowed
    await db.query(
      `update pricing_rules set valid_to = current_date + 10 where city = 'Quaraí' and kind = 'food' and valid_to is null`,
    )
    await db.query(
      `insert into pricing_rules (city, kind, base_fare_brl, included_km, per_km_brl, min_fare_brl,
         night_surcharge_brl, night_from, night_to, cross_border_fee_brl, passenger_cross_border_fee_brl, valid_from)
       values ('Quaraí', 'food', 11, 2, 2.5, 10, 3, '23:00', '05:00', 8, 12, current_date + 10)`,
    )
  })

  test('orders.code é gerado por default e único', async () => {
    const { rows } = await db.query(
      `select column_default from information_schema.columns
       where table_schema='public' and table_name='orders' and column_name='code'`,
    )
    expect(rows[0].column_default).toBeTruthy()
    const u = await db.query(
      `select 1 from pg_indexes where tablename='orders' and indexdef ilike '%unique%(code)%'`,
    )
    expect(u.rows.length).toBe(1)
  })
})
