import type { Client } from 'pg'

/**
 * Role impersonation (see the report): inside a transaction we `set local role authenticated|anon`
 * and `set_config('request.jwt.claims', ..., true)`. That is exactly what PostgREST does per request,
 * and it runs the REAL policies, triggers and helper functions: nothing is simulated. auth.uid() reads
 * the sub from request.jwt.claims, so the identity is the claim's sub and the role comes from profiles.
 */

const u = (n: number) => `a0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const m = (n: number) => `b0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const f = (n: number) => `f0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const o = (n: number) => `c0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
const x = (n: number) => `d0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`

export const ID = {
  admin: u(1), clientA: u(2), clientB: u(3),
  courierQ1: u(4), // Quarai, belongs to fleet F1
  courierQ2: u(5), // Quarai, independent
  courierA1: u(6), // Artigas, belongs to fleet F2
  merchant1: u(7), merchant2: u(8),
  fleetOwner1: u(9), fleetOwner2: u(10),
  blockedAdmin: u(11),
  pendingCourier: u(12), // role courier but a pending profile
  shop1: m(1), // owner merchant1, Quarai, approved
  shop2: m(2), // owner merchant2, Artigas, approved
  shopOrphan: m(3), // NO owner, Quarai, approved (like the two seeded shops)
  shopPending: m(4), // owner merchant2, Artigas, pending
  fleet1: f(1), fleet2: f(2),
  // orders
  oQueueQ: o(1), // client A, courier kind, aguardando_motoboy, Quarai, no courier  -> Quarai queue
  oQueueA: o(2), // client B, food at shop2, pronto, Artigas, no courier            -> Artigas queue
  oTakenQ2: o(3), // client A, courier kind, aceito, courier Q2 (independent)
  oFleet1: o(4), // client A, food at shop1, coletado, courier Q1, fleet F1
  oShop1New: o(5), // client B, food at shop1, aguardando_loja
  oShop1Draft: o(6), // client B, food at shop1, criado (not submitted yet)
  // catalog
  cat1: x(1), cat2: x(2), item1: x(3), item2: x(4), itemOrphan: x(5), itemPending: x(6),
  group1: x(7), group2: x(8), opt1: x(9), opt2: x(10),
  addrA: x(11), addrB: x(12),
  fx1: x(13),
} as const

const addr = (city: string) => JSON.stringify({ city, street_name: 'Rua teste', number: '1' }).replace(/'/g, "''")

/** One round trip: everything a test needs, created inside the caller's open transaction. */
export const FIXTURE_SQL = `
insert into auth.users (id, email) values
  ${Object.entries({
    admin: 1, clientA: 2, clientB: 3, courierQ1: 4, courierQ2: 5, courierA1: 6, merchant1: 7, merchant2: 8,
    fleetOwner1: 9, fleetOwner2: 10, blockedAdmin: 11, pendingCourier: 12,
  })
    .map(([k, n]) => `('${u(n)}', '${k.toLowerCase()}@rls-fixture.invalid')`)
    .join(',\n  ')};

insert into public.profiles (id, role, full_name, status, home_city) values
  ('${ID.admin}', 'admin', 'Admin', 'active', 'quarai'),
  ('${ID.clientA}', 'client', 'Cliente A', 'active', 'quarai'),
  ('${ID.clientB}', 'client', 'Cliente B', 'active', 'artigas'),
  ('${ID.courierQ1}', 'courier', 'Motoboy Q1', 'active', 'quarai'),
  ('${ID.courierQ2}', 'courier', 'Motoboy Q2', 'active', 'quarai'),
  ('${ID.courierA1}', 'courier', 'Motoboy A1', 'active', 'artigas'),
  ('${ID.merchant1}', 'merchant', 'Dono Loja 1', 'active', 'quarai'),
  ('${ID.merchant2}', 'merchant', 'Dono Loja 2', 'active', 'artigas'),
  ('${ID.fleetOwner1}', 'fleet', 'Frota 1', 'active', 'quarai'),
  ('${ID.fleetOwner2}', 'fleet', 'Frota 2', 'active', 'artigas'),
  ('${ID.blockedAdmin}', 'admin', 'Admin bloqueado', 'blocked', 'quarai'),
  ('${ID.pendingCourier}', 'courier', 'Motoboy pendente', 'pending', 'quarai');

insert into public.fleets (id, owner_id, name, city, status) values
  ('${ID.fleet1}', '${ID.fleetOwner1}', 'Tele Quarai', 'quarai', 'approved'),
  ('${ID.fleet2}', '${ID.fleetOwner2}', 'Tele Artigas', 'artigas', 'approved');

insert into public.couriers (profile_id, vehicle, base_city, fleet_id, status) values
  ('${ID.courierQ1}', 'moto', 'quarai', '${ID.fleet1}', 'approved'),
  ('${ID.courierQ2}', 'moto', 'quarai', null, 'approved'),
  ('${ID.courierA1}', 'moto', 'artigas', '${ID.fleet2}', 'approved'),
  ('${ID.pendingCourier}', 'moto', 'quarai', null, 'approved');

insert into public.merchants (id, owner_id, name, kind, city, country, status, commission_pct) values
  ('${ID.shop1}', '${ID.merchant1}', 'Loja 1', 'restaurante', 'quarai', 'BR', 'approved', 12.50),
  ('${ID.shop2}', '${ID.merchant2}', 'Loja 2', 'restaurante', 'artigas', 'UY', 'approved', 15.00),
  ('${ID.shopOrphan}', null, 'Loja sem dono', 'trailer', 'quarai', 'BR', 'approved', 9.00),
  ('${ID.shopPending}', '${ID.merchant2}', 'Loja pendente', 'loja', 'artigas', 'UY', 'pending', 7.00);

insert into public.merchant_hours (merchant_id, weekday, opens_at, closes_at) values
  ('${ID.shop1}', 1, '10:00', '22:00'), ('${ID.shop2}', 1, '10:00', '22:00'), ('${ID.shopOrphan}', 1, '10:00', '22:00');

insert into public.catalog_categories (id, merchant_id, name) values
  ('${ID.cat1}', '${ID.shop1}', 'Lanches'), ('${ID.cat2}', '${ID.shop2}', 'Pratos');

insert into public.catalog_items (id, merchant_id, category_id, name, price_brl) values
  ('${ID.item1}', '${ID.shop1}', '${ID.cat1}', 'X-Pampa', 20.00),
  ('${ID.item2}', '${ID.shop2}', '${ID.cat2}', 'Milanesa', 30.00),
  ('${ID.itemOrphan}', '${ID.shopOrphan}', null, 'Item sem dono', 5.00),
  ('${ID.itemPending}', '${ID.shopPending}', null, 'Item de loja pendente', 8.00);

insert into public.item_option_groups (id, item_id, name) values
  ('${ID.group1}', '${ID.item1}', 'Adicionais'), ('${ID.group2}', '${ID.item2}', 'Guarnicao');
insert into public.item_options (id, group_id, name, price_delta_brl) values
  ('${ID.opt1}', '${ID.group1}', 'Bacon', 3.00), ('${ID.opt2}', '${ID.group2}', 'Fritas', 4.00);

insert into public.addresses (id, profile_id, label, city, country) values
  ('${ID.addrA}', '${ID.clientA}', 'casa', 'quarai', 'BR'), ('${ID.addrB}', '${ID.clientB}', 'casa', 'artigas', 'UY');

insert into public.zones (city, name) values ('quarai', 'Centro (fixture)');
insert into public.fx_rates (id, rate, source) values ('${ID.fx1}', 7.800000, 'manual');
insert into public.settings (key, value, is_public) values ('rls_fixture_private', '"segredo"', false);

insert into public.orders (id, kind, client_id, merchant_id, courier_id, fleet_id, pickup_address, dropoff_address,
                           status, total_brl, total_charged, payment_method, pricing_breakdown, fx_rate_used) values
  ('${ID.oQueueQ}', 'courier', '${ID.clientA}', null, null, null, '${addr('quarai')}', '${addr('quarai')}',
     'aguardando_motoboy', 25.00, 25.00, 'pix', '{"base": 10}', 7.8),
  ('${ID.oQueueA}', 'food', '${ID.clientB}', '${ID.shop2}', null, null, '${addr('artigas')}', '${addr('artigas')}',
     'pronto', 60.00, 60.00, 'dinheiro_brl', '{"base": 10}', 7.8),
  ('${ID.oTakenQ2}', 'courier', '${ID.clientA}', null, '${ID.courierQ2}', null, '${addr('quarai')}', '${addr('quarai')}',
     'aceito', 25.00, 25.00, 'pix', '{"base": 10}', 7.8),
  ('${ID.oFleet1}', 'food', '${ID.clientA}', '${ID.shop1}', '${ID.courierQ1}', '${ID.fleet1}', '${addr('quarai')}', '${addr('quarai')}',
     'coletado', 50.00, 50.00, 'pix', '{"base": 10, "items_subtotal": 40, "commission": 5}', 7.8),
  ('${ID.oShop1New}', 'food', '${ID.clientB}', '${ID.shop1}', null, null, '${addr('quarai')}', '${addr('quarai')}',
     'aguardando_loja', 45.00, 45.00, 'pix', '{"base": 10}', 7.8),
  ('${ID.oShop1Draft}', 'food', '${ID.clientB}', '${ID.shop1}', null, null, '${addr('quarai')}', '${addr('quarai')}',
     'criado', 45.00, 45.00, 'pix', '{"base": 10}', 7.8);

insert into public.order_items (order_id, item_id, name_snapshot, unit_price_brl_snapshot, qty, line_total_brl) values
  ('${ID.oFleet1}', '${ID.item1}', 'X-Pampa', 20.00, 2, 40.00),
  ('${ID.oShop1New}', '${ID.item1}', 'X-Pampa', 20.00, 1, 20.00),
  ('${ID.oQueueA}', '${ID.item2}', 'Milanesa', 30.00, 2, 60.00);

insert into public.order_events (order_id, from_status, to_status, actor_id, actor_role) values
  ('${ID.oFleet1}', 'pronto', 'coletado', '${ID.courierQ1}', 'courier');

insert into public.courier_positions (courier_id, order_id, lat, lng) values
  ('${ID.courierQ1}', '${ID.oFleet1}', -30.3875, -56.4528);
`

export type Who =
  | 'postgres'
  | 'anon'
  | { uid: string | null; claims?: Record<string, unknown> }

/** Switch the transaction's session to a role. 'postgres' returns to the owner (fixtures, assertions). */
export async function actAs(db: Client, who: Who) {
  await db.query('reset role')
  if (who === 'postgres') {
    await db.query(`select set_config('request.jwt.claims', '', true)`)
    return
  }
  if (who === 'anon') {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'anon' })])
    await db.query('set local role anon')
    return
  }
  const claims: Record<string, unknown> = { role: 'authenticated', ...who.claims }
  if (who.uid) claims.sub = who.uid
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
  await db.query('set local role authenticated')
}

export type Attempt =
  | { ok: true; rows: Record<string, unknown>[]; rowCount: number }
  | { ok: false; code?: string; message: string }

/** Run a statement that may be refused, inside a savepoint so the surrounding transaction survives. */
export async function attempt(db: Client, sql: string, params: unknown[] = []): Promise<Attempt> {
  await db.query('savepoint probe')
  try {
    const r = await db.query(sql, params)
    await db.query('release savepoint probe')
    return { ok: true, rows: r.rows, rowCount: r.rowCount ?? 0 }
  } catch (e) {
    await db.query('rollback to savepoint probe')
    const err = e as { code?: string; message: string }
    return { ok: false, code: err.code, message: err.message }
  }
}

/** Read as a role and return the ids (or any single column). */
export async function readAs(db: Client, who: Who, sql: string, col = 'id'): Promise<string[]> {
  await actAs(db, who)
  const r = await db.query(sql)
  return r.rows.map((row) => String(row[col])).sort()
}

/** Run a statement as the owner (for before/after assertions about what really changed). */
export async function asOwner<T extends Record<string, unknown> = Record<string, unknown>>(
  db: Client,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  await actAs(db, 'postgres')
  return (await db.query(sql, params)).rows as T[]
}

export const sorted = (...ids: string[]) => [...ids].sort()
