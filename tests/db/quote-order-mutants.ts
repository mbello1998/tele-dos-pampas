import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Client } from 'pg'

/**
 * Mutation harness for quote_order. "Would this test fail if the thing it tests were broken?" is answered by
 * breaking it, without touching the shared live function.
 *
 * With QUOTE_ORDER_MUTANT=<name> the test file does not call public.quote_order. Inside the test's own
 * transaction (always rolled back) it rebuilds the migration's functions in the session's TEMP schema
 * (pg_temp), with one deliberate defect applied to the SQL text, and calls that copy. 'baseline' applies no
 * defect and must pass every test: it proves the copy is equivalent to what is deployed. Every other mutant
 * must make at least one test fail; one that survives means a guard nobody tests.
 *
 *   QUOTE_ORDER_MUTANT=no-floor npx vitest run tests/db/quote-order.test.ts
 *
 * Each edit must match the migration text exactly once (or at least once with `all`): a stale mutant that no
 * longer matches throws instead of silently passing.
 */
type Edit = { from: string; to: string; all?: boolean }

const MIGRATION = 'supabase/migrations/0021_quote_order.sql'
const HELPERS = ['quote_line', 'quote_point', 'zone_polygon_contains', 'quote_zone_hit', 'quote_items', 'quote_fx']
const QUOTE_HEADER = `) returns jsonb\nlanguage plpgsql stable security definer set search_path = ''`
const GRANT = `to service_role;\n\nrevoke all on function\n  private.quote_line`
const FX_EXACT_DAY = `where f.pair = 'BRL/UYU' and f.valid_for_date = p_day\n  order by f.is_manual_override desc, f.fetched_at desc`
const ITEM_BY_MERCHANT = `where i.id = (v_line ->> 'itemId')::uuid and i.merchant_id = p_merchant;`
const OPTION_OF_ITEM = `where o.id = (v_opt_id #>> '{}')::uuid and og.item_id = v_item.id;`
const NIGHT_EMPTY = `else false\n    end;\n    if v_in_night`

export const MUTANTS: Record<string, Edit[]> = {
  baseline: [],

  // --- taxa de entrega
  'no-floor': [{ from: 'if v_rule.base_fare_brl + v_extra < v_rule.min_fare_brl then', to: 'if false then' }],
  'km-rounded-up': [{ from: 'v_km := p_distance_m::numeric / 1000;', to: 'v_km := ceil(p_distance_m::numeric / 1000);' }],
  'included-km-ignored': [{ from: 'greatest(0, v_km - v_rule.included_km)', to: 'v_km' }],
  'extra-not-rounded': [
    {
      from: 'v_extra := round(greatest(0, v_km - v_rule.included_km) * v_rule.per_km_brl, 2);',
      to: 'v_extra := greatest(0, v_km - v_rule.included_km) * v_rule.per_km_brl;',
    },
  ],
  'zero-distance-free': [
    {
      from: 'v_km := p_distance_m::numeric / 1000;',
      to: `v_km := p_distance_m::numeric / 1000;
    if p_distance_m = 0 then return jsonb_build_object('totalBrl', 0, 'breakdown', '[]'::jsonb, 'blocked', false); end if;`,
    },
  ],

  // --- regra em vigor
  'newest-rule': [
    {
      from: 'and r.valid_from <= v_local::date and (r.valid_to is null or r.valid_to > v_local::date);',
      to: 'order by r.valid_from desc limit 1;',
    },
  ],
  'rule-by-utc-date': [
    {
      from: 'r.valid_from <= v_local::date and (r.valid_to is null or r.valid_to > v_local::date)',
      to: 'r.valid_from <= p_at::date and (r.valid_to is null or r.valid_to > p_at::date)',
    },
  ],
  'rule-from-destination-city': [{ from: 'where r.city = v_o_city and r.kind = p_kind', to: 'where r.city = v_d_city and r.kind = p_kind' }],
  'rule-kind-ignored': [{ from: 'where r.city = v_o_city and r.kind = p_kind', to: `where r.city = v_o_city and r.kind = 'courier'` }],

  // --- adicional noturno
  'no-night': [{ from: 'if v_in_night and v_rule.night_surcharge_brl > 0 then', to: 'if false then' }],
  'night-end-inclusive': [{ from: 'v_local::time < v_rule.night_to', to: 'v_local::time <= v_rule.night_to', all: true }],
  'night-start-exclusive': [
    {
      from: 'v_local::time >= v_rule.night_from and v_local::time < v_rule.night_to',
      to: 'v_local::time > v_rule.night_from and v_local::time < v_rule.night_to',
    },
  ],
  'night-on-utc-clock': [{ from: 'v_local::time', to: `(p_at at time zone 'UTC')::time`, all: true }],
  'night-empty-window-is-all-day': [{ from: NIGHT_EMPTY, to: 'else true\n    end;\n    if v_in_night' }],

  // --- travessia
  'ride-pays-parcel-fee': [
    {
      from: `case when p_kind = 'ride' then v_rule.passenger_cross_border_fee_brl else v_rule.cross_border_fee_brl end`,
      to: 'v_rule.cross_border_fee_brl',
    },
  ],
  'no-cross-border-fee': [{ from: 'if v_amount > 0 then', to: 'if false then' }],
  'crossing-never-flagged': [{ from: 'v_crosses := v_o_country is distinct from v_d_country;', to: 'v_crosses := false;' }],
  'delivery-origin-from-client': [
    { from: 'v_o_city := v_merchant.city;', to: `v_o_city := p_pickup ->> 'city';` },
    { from: 'v_o_country := v_merchant.country;', to: `v_o_country := p_pickup ->> 'country';` },
  ],

  // --- horário de serviço
  'hours-ignored-origin': [{ from: 'if public.is_within_service_hours(v_o_city, p_kind, p_at) is distinct from true', to: 'if false' }],
  'hours-ignored-destination': [
    {
      from: 'or (v_d_city <> v_o_city and public.is_within_service_hours(v_d_city, p_kind, p_at) is distinct from true) then',
      to: 'then',
    },
  ],
  'bridge-closes-at-22': [
    {
      from: 'if public.is_within_service_hours(v_o_city, p_kind, p_at) is distinct from true',
      to: `if (v_crosses and v_local::time >= time '22:00') or public.is_within_service_hours(v_o_city, p_kind, p_at) is distinct from true`,
    },
  ],
  'closed-raises': [{ from: `v_code := 'outside_service_hours';`, to: `raise exception 'closed'; v_code := 'outside_service_hours';` }],

  // --- zonas
  'zone-never-blocks': [{ from: 'if v_zone.zh_blocked then', to: 'if false then' }],
  'zone-block-raises': [
    {
      from: `v_code := 'zone_not_served';\n      v_reason := v_zone.zh_message;\n    end if;\n    v_zone_surcharge`,
      to: `raise exception 'zone'; end if;\n    v_zone_surcharge`,
    },
  ],
  'pickup-zone-ignored': [{ from: 'if v_o_lat is not null and v_o_lng is not null then', to: 'if false then' }],
  'zone-surcharge-not-summed': [{ from: 'v_total := v_total + v_zone_surcharge;', to: 'null;' }],
  'zone-surcharge-summed-not-max': [{ from: 'v_surcharge := greatest(v_surcharge, z.surcharge_brl);', to: 'v_surcharge := v_surcharge + z.surcharge_brl;' }],
  'zone-holes-ignored': [{ from: 'v_inside := not v_inside;', to: 'v_inside := true;' }],
  'zone-city-ignored': [{ from: 'where zz.city = p_city and zz.polygon is not null', to: 'where zz.polygon is not null' }],
  'zone-lat-lng-swapped': [
    {
      from: 'xi := (v_ring -> i ->> 0)::numeric;\n        yi := (v_ring -> i ->> 1)::numeric;\n        xj := (v_ring -> j ->> 0)::numeric;\n        yj := (v_ring -> j ->> 1)::numeric;',
      to: 'xi := (v_ring -> i ->> 1)::numeric;\n        yi := (v_ring -> i ->> 0)::numeric;\n        xj := (v_ring -> j ->> 1)::numeric;\n        yj := (v_ring -> j ->> 0)::numeric;',
    },
  ],
  'zone-malformed-skipped': [
    {
      from: `raise exception 'zone % has a malformed polygon: a ring needs at least 4 positions', p_zone using errcode = '55000';`,
      to: 'return false;',
    },
  ],
  'zone-message-ignores-notes': [{ from: `nullif(btrim(z.notes), ''),`, to: '' }],

  // --- itens
  'client-price-trusted': [{ from: 'v_unit := v_item.price_brl;', to: `v_unit := coalesce((v_line ->> 'price')::numeric, v_item.price_brl);` }],
  'qty-ignored': [{ from: 'v_subtotal := v_subtotal + v_unit * v_qty;', to: 'v_subtotal := v_subtotal + v_unit;' }],
  'option-delta-ignored': [{ from: 'v_unit := v_unit + v_opt.price_delta_brl;', to: 'v_unit := v_unit;' }],
  'duplicate-option-allowed': [{ from: 'if v_opt.id = any (v_seen) then', to: 'if false then' }],
  'group-limits-ignored': [{ from: 'if v_cnt < v_min or v_cnt > g.max_select then', to: 'if false then' }],
  'required-flag-ignored': [
    {
      from: 'v_min := case when g.is_required then greatest(g.min_select, 1) else g.min_select end;',
      to: 'v_min := g.min_select;',
    },
  ],
  'other-merchant-item-allowed': [{ from: ITEM_BY_MERCHANT, to: `where i.id = (v_line ->> 'itemId')::uuid;` }],
  'option-of-other-item-allowed': [{ from: OPTION_OF_ITEM, to: `where o.id = (v_opt_id #>> '{}')::uuid;` }],
  'unavailable-item-priced': [{ from: 'if not v_item.is_available then', to: 'if false then' }],
  'unavailable-option-priced': [{ from: 'if not v_opt.is_available then', to: 'if false then' }],
  'negative-unit-allowed': [{ from: 'if v_unit < 0 then', to: 'if false then' }],
  'qty-unchecked': [{ from: 'if v_qty not between 1 and 99 then', to: 'if false then' }],

  // --- comissão
  'commission-truncated': [
    {
      from: 'v_commission := round(v_items_subtotal * v_merchant.commission_pct / 100, 2);',
      to: 'v_commission := trunc(v_items_subtotal * v_merchant.commission_pct / 100, 2);',
    },
  ],
  'commission-added-to-total': [{ from: 'v_total := v_total + v_items_subtotal;', to: 'v_total := v_total + v_items_subtotal + v_commission;' }],
  'commission-line-in-breakdown': [
    {
      from: 'v_total := v_total + v_items_subtotal;',
      to: `v_total := v_total + v_items_subtotal;\n      v_lines := v_lines || private.quote_line('commission', v_commission);`,
    },
  ],
  // The CHECK's regex would not catch this name: only the intent test does.
  'commission-hidden-as-platform-fee': [
    {
      from: 'v_total := v_total + v_items_subtotal;',
      to: `v_total := v_total + v_items_subtotal;\n      v_lines := v_lines || private.quote_line('platform_fee', v_commission);\n      v_total := v_total + v_commission;`,
    },
  ],

  // --- câmbio
  'fx-rounds-nearest': [{ from: 'v_uyu := ceil(round(', to: 'v_uyu := round(round(' }],
  'fx-spread-ignored': [
    {
      from: 'v_uyu := ceil(round(v_total * v_fx_rate * (1 + v_fx_spread / 100), 6));',
      to: 'v_uyu := ceil(round(v_total * v_fx_rate, 6));',
    },
  ],
  'fx-on-utc-day': [{ from: `(p_at at time zone 'America/Montevideo')::date`, to: 'p_at::date' }],
  'fx-manual-not-preferred': [
    { from: FX_EXACT_DAY, to: `where f.pair = 'BRL/UYU' and f.valid_for_date = p_day\n  order by f.fetched_at asc` },
  ],
  'fx-uses-future-rows': [{ from: 'f.valid_for_date < p_day', to: 'f.valid_for_date <> p_day' }],
  'fx-never-stale': [{ from: 'return query select r.id, r.rate, r.spread_pct, true;', to: 'return query select r.id, r.rate, r.spread_pct, false;' }],
  'fx-fallback-ignores-settings': [
    { from: `select s.value into v from public.settings s where s.key = 'fx.fallback_rate';`, to: 'v := null;' },
  ],
  'fx-fallback-accepts-zero': [{ from: 'if v_rate is null or v_rate <= 0 then', to: 'if v_rate is null then' }],

  // --- forma e blindagem
  'not-security-definer': [{ from: QUOTE_HEADER, to: `) returns jsonb\nlanguage plpgsql stable set search_path = ''` }],
  'search-path-unpinned': [{ from: QUOTE_HEADER, to: `) returns jsonb\nlanguage plpgsql stable security definer` }],
  // unqualified + unpinned: a same-named temp table of the caller would be read instead of the real one
  'items-read-through-search-path': [
    { from: 'from public.catalog_items i\n    where i.id', to: 'from catalog_items i\n    where i.id' },
    {
      from: `returns table (qi_subtotal numeric, qi_unavailable text)\nlanguage plpgsql stable set search_path = ''`,
      to: `returns table (qi_subtotal numeric, qi_unavailable text)\nlanguage plpgsql stable`,
    },
  ],
  'merchant-read-through-search-path': [
    { from: 'select m.* into v_merchant from public.merchants m where m.id = p_merchant;', to: 'select m.* into v_merchant from merchants m where m.id = p_merchant;' },
    { from: QUOTE_HEADER, to: `) returns jsonb\nlanguage plpgsql stable security definer` },
  ],
  'granted-to-authenticated': [{ from: GRANT, to: `to service_role, authenticated, anon;\n\nrevoke all on function\n  private.quote_line` }],
  'granted-to-public': [
    {
      from: '  from public, anon, authenticated;\ngrant execute on function public.quote_order',
      to: '  from anon, authenticated;\ngrant execute on function public.quote_order',
    },
  ],

  // --- entradas
  'null-distance-accepted': [{ from: 'or p_distance_m is null or', to: 'or' }],
  'negative-distance-accepted': [{ from: 'if p_distance_m < 0 then', to: 'if false then' }],
  'city-country-not-paired': [
    {
      from: `if not ((v_city = 'quarai' and v_country = 'BR') or (v_city = 'artigas' and v_country = 'UY')) then`,
      to: 'if v_city is null then',
    },
  ],
  'missing-coordinates-accepted': [
    {
      from: `if jsonb_typeof(p_point -> 'lat') is distinct from 'number' or jsonb_typeof(p_point -> 'lng') is distinct from 'number' then`,
      to: 'if false then',
    },
  ],
  'items-on-courier-accepted': [{ from: `raise exception 'quote_order: a % order has no items', p_kind using errcode = '22023';`, to: 'null;' }],
  'merchant-on-courier-accepted': [{ from: `raise exception 'quote_order: a % order has no merchant', p_kind using errcode = '22023';`, to: 'null;' }],
}

export const isMutantRun = (): boolean => Boolean(process.env.QUOTE_ORDER_MUTANT)

export async function installMutant(db: Client): Promise<string> {
  const name = process.env.QUOTE_ORDER_MUTANT ?? ''
  const edits = MUTANTS[name]
  if (!edits) throw new Error(`unknown mutant "${name}"`)
  // normalise line endings: a Windows checkout may hand us CRLF, and the edits below use LF
  let sql = readFileSync(resolve(process.cwd(), MIGRATION), 'utf8').replaceAll(String.fromCharCode(13, 10), String.fromCharCode(10))
  for (const e of edits) {
    const n = sql.split(e.from).length - 1
    if (e.all ? n < 1 : n !== 1) throw new Error(`mutant "${name}" is stale: ${n} matches for ${JSON.stringify(e.from.slice(0, 70))}`)
    sql = sql.split(e.from).join(e.to)
  }
  sql = sql.split('public.quote_order').join('pg_temp.quote_order')
  for (const h of HELPERS) sql = sql.split(`private.${h}`).join(`pg_temp.${h}`)
  await db.query(sql)
  return 'pg_temp.quote_order'
}
