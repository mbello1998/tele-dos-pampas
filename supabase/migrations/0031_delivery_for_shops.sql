-- 0031: Fatia 1b, a tela da loja. A shop does not browse a catalogue: it already sold the meal on WhatsApp and is
-- now HIRING A MOTORCYCLE. So `delivery` becomes a plain transport order with four facts about it: where the bag
-- goes (the buyer's address), what is in it (free text), what the courier collects from the buyer (optional) and who
-- pays the delivery (the shop or the buyer, per order). The platform computes the fee; the shop never types it.
--
-- WHAT THIS MIGRATION DOES, in the order it does it
--   1. orders gets load_description, collect_amount_brl, delivery_fee_payer and delivery_fee_brl. No items relation.
--   2. pricing_rules gets an AUDIENCE ('client' | 'merchant'): the same route has two prices, the counter price a
--      passenger or errand customer pays and the cheaper AGREEMENT price a registered shop pays. The no-overlap
--      exclusion becomes per (city, kind, audience), so each tariff keeps its own validity window.
--   3. The tele's owner (role 'fleet') may INSERT and UPDATE pricing_rules, like the admin. The history guard
--      (0017) is untouched: UPDATE still only closes a version with valid_to, DELETE is still impossible for every
--      role, and a price change is always a NEW DATED ROW.
--   4. The merchant tariff is seeded for delivery in both cities, and the counter tariff for delivery is set to the
--      owner's own example (see the numbers below), both through dated rows, never an edit.
--   5. quote_order gains the no-items branch for delivery: it prices on the merchant audience and returns
--      delivery fee + zone + night + border crossing + pesos. No items subtotal, no commission.
--   6. create_order gains the delivery path: the caller must OWN the merchant, the pickup is always the shop's stored
--      coordinates, and nothing is written to order_commissions any more.
--
-- THE NUMBERS (the owner's words: "para o cliente vai ser 9 reais a entrega, mas para o dono do restaurante ele vai
-- pagar 8, justamente por ter convênio com a plataforma")
--                      base (2 km incl.)   per km beyond   minimum   night    border crossing
--   delivery, client       R$ 9,00            R$ 2,50       R$ 9,00   R$ 3,00     R$ 8,00     <- was a R$ 10,00 placeholder
--   delivery, merchant     R$ 8,00            R$ 2,20       R$ 8,00   R$ 3,00     R$ 8,00     <- new
-- Same trip inside 2 km: R$ 9,00 at the counter, R$ 8,00 on the agreement. Beyond 2 km the merchant per-km is the
-- counter's scaled by the same 8/9 and rounded to the centavo (2,50 x 8/9 = 2,22 -> 2,20), so the agreement is
-- cheaper at EVERY distance, not only inside the first kilometres. Night and border crossing are costs of the trip
-- itself (a night rider, a bridge toll in time), not of who hired it, so they are the same on both tariffs. The
-- counter delivery row was a R$ 10,00 placeholder from the first seed; it is closed (valid_to = today in Quarai)
-- and replaced by a R$ 9,00 row dated today, only if it is still exactly that placeholder: a price somebody set
-- later is never overwritten by a migration. courier and ride are NOT touched.
--
-- ORDER_COMMISSIONS. create_order stops writing it. Leaving it empty breaks nothing: orders has no column or FK
-- pointing at it (the FK runs the other way, order_commissions.order_id -> orders.id), no view, function or trigger
-- reads it other than the old create_order, and its only dependents are its own CHECK and the merchants' SELECT
-- policy, which simply returns zero rows. The table stays, unused, pending the owner's approval to drop.
--
-- WHAT THIS MIGRATION DOES NOT DO: no DROP TABLE, no DROP COLUMN, no DELETE, no TRUNCATE. The catalogue tables
-- (catalog_*, item_*, order_items), merchants.commission_pct, order_commissions and private.quote_items stay, unused.
-- The only DROP is the OLD 13-argument create_order (a function: its replacement adds three trailing arguments, and
-- a leftover overload would let a caller reach the items path).

-- ---------------------------------------------------------------------------------------------
-- 1. orders: what a shop's delivery carries
-- ---------------------------------------------------------------------------------------------
alter table public.orders
  add column load_description text,
  add column collect_amount_brl numeric(10,2),
  add column delivery_fee_payer text,
  add column delivery_fee_brl numeric(10,2);

-- Domain checks only. Whether a delivery MUST carry them is create_order's rule (older rows and fixtures that
-- insert a delivery order directly stay valid).
alter table public.orders
  add constraint orders_load_description_len check (load_description is null or char_length(load_description) <= 500),
  add constraint orders_collect_amount_brl_check check (collect_amount_brl is null or collect_amount_brl >= 0),
  add constraint orders_delivery_fee_payer_check check (delivery_fee_payer is null or delivery_fee_payer in ('client', 'merchant')),
  add constraint orders_delivery_fee_brl_check check (delivery_fee_brl is null or delivery_fee_brl >= 0),
  add constraint orders_delivery_only_columns check (
    kind = 'delivery'
    or (load_description is null and collect_amount_brl is null and delivery_fee_payer is null and delivery_fee_brl is null)
  );

comment on column public.orders.load_description is 'delivery: what is in the bag, free text typed by the shop ("2 xis de coração, 1 coca").';
comment on column public.orders.collect_amount_brl is 'delivery: what the courier collects from the buyer for the goods, in reais, before any delivery fee. Null = nothing to collect.';
comment on column public.orders.delivery_fee_payer is 'delivery: who owes the delivery fee, chosen by the shop per order. client = the courier also collects the fee from the buyer; merchant = the shop settles it.';
comment on column public.orders.delivery_fee_brl is 'delivery: the delivery fee as the platform quoted it (merchant tariff), frozen. Equals total_brl.';

-- ---------------------------------------------------------------------------------------------
-- 2. pricing_rules: two tariffs, one table
-- ---------------------------------------------------------------------------------------------
-- ADD COLUMN with a constant default fires no UPDATE trigger, so the history guard never sees it: every existing
-- row becomes the counter ('client') tariff.
alter table public.pricing_rules
  add column audience text not null default 'client' check (audience in ('client', 'merchant'));

comment on column public.pricing_rules.audience is 'Who pays this tariff. client = the counter price (passenger, errand customer); merchant = the agreement price of a registered shop. quote_order picks merchant for kind delivery and client for everything else.';

alter table public.pricing_rules drop constraint pricing_rules_no_overlap;
alter table public.pricing_rules
  add constraint pricing_rules_no_overlap exclude using gist (
    city with =, kind with =, audience with =, daterange(valid_from, valid_to) with &&
  );

-- ---------------------------------------------------------------------------------------------
-- 3. the tele's owner changes prices, not only the admin
-- ---------------------------------------------------------------------------------------------
-- pricing_rules has no fleet_id: with one tele in the city that is moot; with two, any fleet profile could close
-- another's tariff. Recorded as the first thing to settle if a second tele appears. The SELECT policy already
-- admits 'fleet'. A tariff change stays traceable: audit_write records actor, before and after on every write.
create policy pricing_rules_insert_fleet on public.pricing_rules for insert to authenticated
  with check ((select public.app_role()) = 'fleet');
create policy pricing_rules_update_fleet on public.pricing_rules for update to authenticated
  using ((select public.app_role()) = 'fleet')
  with check ((select public.app_role()) = 'fleet');

-- ---------------------------------------------------------------------------------------------
-- 4. the two delivery tariffs (dated rows; nothing is edited)
-- ---------------------------------------------------------------------------------------------
do $$
declare
  v_day date := (now() at time zone 'America/Montevideo')::date; -- both cities share this civil date
  r record;
begin
  -- the counter placeholder (R$ 10 / 2 km / R$ 2,50, from seed.sql) becomes the owner's R$ 9
  for r in
    select * from public.pricing_rules p
    where p.kind = 'delivery' and p.audience = 'client' and p.valid_to is null and p.valid_from < v_day
      and p.base_fare_brl = 10.00 and p.min_fare_brl = 10.00 and p.included_km = 2.0 and p.per_km_brl = 2.50
  loop
    update public.pricing_rules set valid_to = v_day where id = r.id; -- the only column the guard lets change
    insert into public.pricing_rules (
      city, kind, audience, base_fare_brl, included_km, per_km_brl, min_fare_brl, night_surcharge_brl, night_from,
      night_to, cross_border_fee_brl, passenger_cross_border_fee_brl, service_fee_pct, valid_from
    ) values (
      r.city, r.kind, 'client', 9.00, r.included_km, r.per_km_brl, 9.00, r.night_surcharge_brl, r.night_from,
      r.night_to, r.cross_border_fee_brl, r.passenger_cross_border_fee_brl, r.service_fee_pct, v_day
    );
  end loop;
end
$$;

-- a database that never had the placeholder (a fresh replay: seed.sql runs AFTER the migrations) gets the counter
-- row here too. seed.sql seeds a (city, kind) only when none exists, so it must find this one and not skip delivery.
insert into public.pricing_rules (
  city, kind, audience, base_fare_brl, included_km, per_km_brl, min_fare_brl, night_surcharge_brl, night_from,
  night_to, cross_border_fee_brl, passenger_cross_border_fee_brl, service_fee_pct, valid_from
)
select c.city, 'delivery'::public.order_kind, 'client', 9.00, 2.0, 2.50, 9.00, 3.00, '23:00', '05:00', 8.00, 12.00, 0.00,
       date '2026-01-01'
from (values ('quarai'), ('artigas')) as c (city)
where not exists (
  select 1 from public.pricing_rules p where p.city = c.city and p.kind = 'delivery' and p.audience = 'client'
);

-- the agreement tariff: one open-ended version per city
insert into public.pricing_rules (
  city, kind, audience, base_fare_brl, included_km, per_km_brl, min_fare_brl, night_surcharge_brl, night_from,
  night_to, cross_border_fee_brl, passenger_cross_border_fee_brl, service_fee_pct, valid_from
)
select c.city, 'delivery'::public.order_kind, 'merchant', 8.00, 2.0, 2.20, 8.00, 3.00, '23:00', '05:00', 8.00, 12.00, 0.00,
       date '2026-01-01'
from (values ('quarai'), ('artigas')) as c (city)
where not exists (
  select 1 from public.pricing_rules p where p.city = c.city and p.kind = 'delivery' and p.audience = 'merchant'
);

-- ---------------------------------------------------------------------------------------------
-- 5. quote_order: the delivery branch has no items
-- ---------------------------------------------------------------------------------------------
-- Same signature, same posture: SECURITY DEFINER, search_path pinned, EXECUTE only for service_role. p_items stays in
-- the signature (the Server Action and old callers pass null) but a delivery refuses a non-empty one. The returned
-- object loses commissionBrl (there is no commission) and gains `audience`, the tariff that priced the order.
create or replace function public.quote_order(
  p_kind public.order_kind,
  p_pickup jsonb,
  p_dropoff jsonb,
  p_merchant uuid,
  p_items jsonb,
  p_at timestamptz,
  p_distance_m integer,
  p_route_source public.route_source
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_merchant public.merchants%rowtype;
  v_o_city text;
  v_o_country text;
  v_o_lat numeric;
  v_o_lng numeric;
  v_pt record;
  v_d_city text;
  v_d_country text;
  v_d_lat numeric;
  v_d_lng numeric;
  v_tz text;
  v_local timestamp;
  v_audience text;
  v_rule public.pricing_rules%rowtype;
  v_crosses boolean;

  v_code text;
  v_reason text;
  v_zone record;
  v_zone_surcharge numeric := 0;

  v_lines jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_km numeric;
  v_extra numeric;
  v_amount numeric;
  v_in_night boolean;
  v_fee_key text;

  v_fx_id uuid;
  v_fx_rate numeric;
  v_fx_spread numeric;
  v_fx_stale boolean;
  v_uyu numeric;
  v_rate_used numeric;
begin
  -- 1. the call itself must be well-formed; nothing here is guessed
  if p_kind is null or p_at is null or p_distance_m is null or p_route_source is null then
    raise exception 'quote_order: kind, instant, distance and route source are required' using errcode = '22004';
  end if;
  if p_distance_m < 0 then
    raise exception 'quote_order: the distance cannot be negative (got % m)', p_distance_m using errcode = '22023';
  end if;
  -- no order of any kind has items any more
  if p_items is not null
     and not (case when jsonb_typeof(p_items) = 'array' then jsonb_array_length(p_items) = 0 else false end) then
    raise exception 'quote_order: a % order has no items', p_kind using errcode = '22023';
  end if;

  -- 2. origin and destination. For delivery the ORIGIN IS THE SHOP, from the database, whatever p_pickup says.
  if p_kind = 'delivery' then
    if p_merchant is null then
      raise exception 'quote_order: a delivery order needs a merchant' using errcode = '22023';
    end if;
    select m.* into v_merchant from public.merchants m where m.id = p_merchant;
    if not found then
      raise exception 'quote_order: merchant % does not exist', p_merchant using errcode = '22023';
    end if;
    if v_merchant.lat is null or v_merchant.lng is null then
      raise exception 'quote_order: merchant % has no stored coordinates, so there is nowhere to collect', p_merchant
        using errcode = '22023';
    end if;
    v_o_city := v_merchant.city;
    v_o_country := v_merchant.country;
    v_o_lat := v_merchant.lat;
    v_o_lng := v_merchant.lng;
  else
    if p_merchant is not null then
      raise exception 'quote_order: a % order has no merchant', p_kind using errcode = '22023';
    end if;
    select * into v_pt from private.quote_point('pickup', p_pickup);
    v_o_city := v_pt.pt_city;
    v_o_country := v_pt.pt_country;
    v_o_lat := v_pt.pt_lat;
    v_o_lng := v_pt.pt_lng;
  end if;
  select * into v_pt from private.quote_point('dropoff', p_dropoff);
  v_d_city := v_pt.pt_city;
  v_d_country := v_pt.pt_country;
  v_d_lat := v_pt.pt_lat;
  v_d_lng := v_pt.pt_lng;
  v_crosses := v_o_country is distinct from v_d_country;

  -- 3. the rule IN FORCE at the instant, on the origin city's civil date, for the audience that is paying:
  --    a registered shop hiring a delivery pays the agreement tariff; everyone else pays the counter tariff.
  v_audience := case when p_kind = 'delivery' then 'merchant' else 'client' end;
  select s.value -> v_o_city ->> 'timezone' into v_tz from public.settings s where s.key = 'service_hours';
  if v_tz is null then
    raise exception 'service_hours has no timezone for city %', v_o_city using errcode = '55000';
  end if;
  v_local := p_at at time zone v_tz;
  select r.* into v_rule from public.pricing_rules r
  where r.city = v_o_city and r.kind = p_kind and r.audience = v_audience
    and r.valid_from <= v_local::date and (r.valid_to is null or r.valid_to > v_local::date);
  if not found then
    raise exception 'no pricing_rules version in force for city %, kind %, audience % on %', v_o_city, p_kind, v_audience, v_local::date
      using errcode = '55000';
  end if;

  -- 4. service hours (06:00-00:00, the municipality's rule about the SERVICE; the bridge has no hours).
  --    Both cities of a crossing must be open. The function raises on a malformed window (fail closed), and
  --    anything that is not exactly TRUE is treated as closed. The SHOP's own hours are not checked: they are
  --    operational information now, and the shop is the one asking.
  if public.is_within_service_hours(v_o_city, p_kind, p_at) is distinct from true
     or (v_d_city <> v_o_city and public.is_within_service_hours(v_d_city, p_kind, p_at) is distinct from true) then
    v_code := 'outside_service_hours';
    v_reason := coalesce(
      (select s.value ->> 'pt-BR' from public.settings s where s.key = 'landing_hours_notice'),
      'outside_service_hours'
    );
  end if;

  -- 5. zones: an unserved zone at either end blocks; otherwise the largest surcharge applies (one line)
  if v_code is null then
    select * into v_zone from private.quote_zone_hit(v_d_city, v_d_lat, v_d_lng);
    if v_zone.zh_blocked then
      v_code := 'zone_not_served';
      v_reason := v_zone.zh_message;
    end if;
    v_zone_surcharge := v_zone.zh_surcharge;
    if v_o_lat is not null and v_o_lng is not null then
      select * into v_zone from private.quote_zone_hit(v_o_city, v_o_lat, v_o_lng);
      if v_code is null and v_zone.zh_blocked then
        v_code := 'zone_not_served';
        v_reason := v_zone.zh_message;
      end if;
      v_zone_surcharge := greatest(v_zone_surcharge, v_zone.zh_surcharge);
    end if;
  end if;

  -- 6. the price, line by line. Each amount is rounded to centavos where it is born, so the lines sum to the
  --    total exactly.
  if v_code is null then
    v_km := p_distance_m::numeric / 1000;
    v_extra := round(greatest(0, v_km - v_rule.included_km) * v_rule.per_km_brl, 2);
    if v_rule.base_fare_brl + v_extra < v_rule.min_fare_brl then
      -- below the minimum: the minimum is charged, as one delivery line (key base, label min_fare)
      v_lines := v_lines || private.quote_line('base', v_rule.min_fare_brl, 'pricing.min_fare');
      v_total := v_rule.min_fare_brl;
    else
      v_lines := v_lines || private.quote_line('base', v_rule.base_fare_brl);
      v_total := v_rule.base_fare_brl;
      if v_extra > 0 then
        v_lines := v_lines || private.quote_line('extra_km', v_extra);
        v_total := v_total + v_extra;
      end if;
    end if;

    if v_zone_surcharge > 0 then
      v_lines := v_lines || private.quote_line('zone_surcharge', v_zone_surcharge);
      v_total := v_total + v_zone_surcharge;
    end if;

    -- night window [night_from, night_to) on the origin city's clock; it crosses midnight when from > to;
    -- from = to is an empty window (no surcharge) rather than "all day"
    v_in_night := case
      when v_rule.night_from < v_rule.night_to then v_local::time >= v_rule.night_from and v_local::time < v_rule.night_to
      when v_rule.night_from > v_rule.night_to then v_local::time >= v_rule.night_from or v_local::time < v_rule.night_to
      else false
    end;
    if v_in_night and v_rule.night_surcharge_brl > 0 then
      v_lines := v_lines || private.quote_line('night_surcharge', v_rule.night_surcharge_brl);
      v_total := v_total + v_rule.night_surcharge_brl;
    end if;

    if v_crosses then
      v_amount := case when p_kind = 'ride' then v_rule.passenger_cross_border_fee_brl else v_rule.cross_border_fee_brl end;
      v_fee_key := case when p_kind = 'ride' then 'passenger_cross_border_fee' else 'cross_border_fee' end;
      if v_amount > 0 then
        v_lines := v_lines || private.quote_line(v_fee_key, v_amount);
        v_total := v_total + v_amount;
      end if;
    end if;

    -- 7. pesos: rate of the city's civil day (both cities share UTC-3, as getEffectiveRate does) plus the
    --    spread, rounded UP to a whole peso. Same arithmetic as convertBrlToUyu in src/lib/money/format.ts,
    --    including the 6-decimal trim before the ceiling (what the TypeScript uses against float noise).
    select f.fx_id, f.fx_rate, f.fx_spread, f.fx_stale into v_fx_id, v_fx_rate, v_fx_spread, v_fx_stale
    from private.quote_fx((p_at at time zone 'America/Montevideo')::date) f;
    v_rate_used := round(v_fx_rate * (1 + v_fx_spread / 100), 6);
    v_uyu := ceil(round(v_total * v_fx_rate * (1 + v_fx_spread / 100), 6));
  end if;

  return jsonb_build_object(
    'breakdown', v_lines,
    'totalBrl', v_total,
    'pricingRuleId', v_rule.id,
    'audience', v_audience,
    'distanceM', p_distance_m,
    'routeSource', p_route_source,
    'crossesBorder', v_crosses,
    'blocked', v_code is not null,
    'blockedReason', v_reason,
    'blockedCode', v_code,
    'fxRateId', v_fx_id,
    'fxRate', v_fx_rate,
    'fxSpreadPct', v_fx_spread,
    'fxRateUsed', v_rate_used,
    'fxStale', v_fx_stale,
    'totalUyu', v_uyu
  );
end
$$;

comment on function public.quote_order(public.order_kind, jsonb, jsonb, uuid, jsonb, timestamptz, integer, public.route_source) is
  'The pricing engine (spec 7). The distance is an INPUT computed on the server (routeDistance); not executable by authenticated or anon. A delivery (hired by a shop, no items) is priced on the merchant (agreement) tariff and starts at the shop''s stored coordinates; every other kind on the client (counter) tariff. Returns the Quote of src/lib/pricing/types.ts plus audience, blockedCode and fxRateId/fxRate/fxSpreadPct/fxRateUsed/fxStale/totalUyu. There is no commission. Blocked quotes (service closed, unserved zone) have total 0, an empty breakdown and null fx fields; they do not raise. Malformed input and broken configuration (no rule in force, bad service window, bad zone polygon) raise.';

revoke all on function public.quote_order(public.order_kind, jsonb, jsonb, uuid, jsonb, timestamptz, integer, public.route_source)
  from public, anon, authenticated;
grant execute on function public.quote_order(public.order_kind, jsonb, jsonb, uuid, jsonb, timestamptz, integer, public.route_source)
  to service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. create_order: the delivery path
-- ---------------------------------------------------------------------------------------------
-- AUTHORISATION CHANGES SHAPE. For ride and courier it is what it always was: p_client_id must be an active profile
-- with role 'client'. For delivery it is: p_client_id must be an active profile with role 'merchant' AND must own
-- the merchant (merchants.owner_id) this delivery is for. TD010 either way. p_client_id is still the id the Server
-- Action took from the verified session, never from the body.
--
-- DELIVERY, in what differs from the others
--   - the pickup is the shop's stored coordinates and address, read here from `merchants`; p_pickup is ignored.
--   - p_items must be empty; p_load_description (1..500 characters) is required; p_delivery_fee_payer is required.
--   - the shop's opening hours do not block it (TD003 is not raised): they are operational information.
--   - the order is born `pronto`: the shop is calling the courier for a bag that is ready, and `pronto` is the status
--     the courier queue shows for delivery (private.courier_sees_order). The first order_events row is
--     (null -> pronto, actor_role merchant).
--   - payment: p_payment_method says in which cash the BUYER pays the courier, dinheiro_brl or dinheiro_uyu (pix is
--     TD008). What the courier collects = collect_amount_brl + the fee when the buyer pays it; in pesos it is
--     converted with the quote's rate and rounded up, like every peso amount here. p_change_for (optional) is the
--     note the buyer will hand over, in that currency, and must cover what is collected. total_brl and
--     delivery_fee_brl hold the FEE; total_charged / currency_charged hold what is collected from the buyer.
--   - p_client_total_uyu is not compared: the pesos the screen shows for a delivery are those of the goods, not of
--     the fee. The BRL fee is compared with the one-centavo tolerance, as always.
--   - rate limit: its own ceiling (settings['orders.delivery_rate_limit_per_10min'], default 30) because a shop at lunch
--     legitimately sends more than the 5 a passenger could. Still per PROFILE, still serialised by the advisory lock.
-- Kept as they were: the server re-quote with the server's distance, the haversine floor (TD012), the frozen
-- breakdown, the duplicate-tap guard (TD011; a delivery also compares the bag), the first order_events row.
-- The commission is gone: nothing is written to order_commissions.
insert into public.settings (key, value, is_public) values
  ('orders.delivery_rate_limit_per_10min', '30', false)
on conflict (key) do nothing;

drop function public.create_order(uuid, public.order_kind, jsonb, jsonb, uuid, jsonb, public.payment_method, numeric, numeric, numeric, integer, public.route_source, text);

create function public.create_order(
  p_client_id uuid,
  p_kind public.order_kind,
  p_pickup jsonb,
  p_dropoff jsonb,
  p_merchant uuid,
  p_items jsonb,
  p_payment_method public.payment_method,
  p_change_for numeric,
  p_client_total_brl numeric,
  p_client_total_uyu numeric,
  p_distance_m integer,
  p_route_source public.route_source,
  p_client_notes text default null,
  p_load_description text default null,
  p_collect_amount_brl numeric default null,
  p_delivery_fee_payer text default null
) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  c_window constant interval := interval '10 minutes';
  v_now timestamptz := now();
  v_is_delivery boolean := p_kind = 'delivery';
  v_profile record;
  v_limit integer;
  v_recent integer;
  v_max_distance integer;
  v_merchant public.merchants%rowtype;
  v_quote jsonb;
  v_block text;
  v_total numeric;
  v_uyu numeric;
  v_currency text;
  v_charged numeric;
  v_crosses boolean;
  v_pickup jsonb;
  v_order_id uuid;
  v_code text;
  v_constraint text;
  v_try integer;
  v_dup_window integer;
  v_dup_code text;
  v_a_lat numeric;
  v_a_lng numeric;
  v_b_lat numeric;
  v_b_lng numeric;
  v_haversine numeric;
  v_load text := nullif(btrim(p_load_description), '');
  v_collect numeric;
  v_owed_brl numeric;
  v_status public.order_status;
begin
  -- 0. a well-formed call. Totals, distance and payment are never defaulted.
  if p_client_id is null or p_kind is null or p_payment_method is null or p_client_total_brl is null
     or p_distance_m is null or p_route_source is null then
    raise exception 'create_order: client, kind, payment method, client total, distance and route source are required'
      using errcode = '22004';
  end if;
  if p_dropoff is null or jsonb_typeof(p_dropoff) is distinct from 'object' or length(p_dropoff::text) > 4000
     or (p_pickup is not null and (jsonb_typeof(p_pickup) is distinct from 'object' or length(p_pickup::text) > 4000)) then
    raise exception 'create_order: addresses must be JSON objects of at most 4000 characters' using errcode = '22023';
  end if;
  if length(coalesce(p_client_notes, '')) > 500 then
    raise exception 'create_order: the notes are limited to 500 characters' using errcode = '22023';
  end if;
  if v_is_delivery then
    if v_load is null or length(v_load) > 500 then
      raise exception 'create_order: a delivery needs a description of what is in the bag (1 to 500 characters)'
        using errcode = '22023';
    end if;
    if p_delivery_fee_payer is null or p_delivery_fee_payer not in ('client', 'merchant') then
      raise exception 'create_order: a delivery needs delivery_fee_payer client or merchant' using errcode = '22023';
    end if;
    if p_collect_amount_brl = 'NaN'::numeric or p_collect_amount_brl < 0 or p_collect_amount_brl > 10000
       or p_collect_amount_brl <> round(p_collect_amount_brl, 2) then
      raise exception 'create_order: collect_amount_brl must be between 0 and 10000 with at most two decimals'
        using errcode = '22023';
    end if;
    if p_payment_method not in ('dinheiro_brl', 'dinheiro_uyu') then
      raise exception 'create_order: on a delivery the buyer pays the courier in cash, reais or pesos' using errcode = 'TD008';
    end if;
  elsif v_load is not null or p_collect_amount_brl is not null or p_delivery_fee_payer is not null then
    raise exception 'create_order: load description, collect amount and fee payer belong to a delivery' using errcode = '22023';
  end if;

  -- 1. who is ordering. Ride and courier: an active client. Delivery: an active merchant profile that OWNS the shop.
  select pr.role, pr.status into v_profile from public.profiles pr where pr.id = p_client_id;
  if not found or v_profile.status is distinct from 'active'
     or v_profile.role is distinct from (case when v_is_delivery then 'merchant' else 'client' end)::public.user_role then
    raise exception 'create_order: profile % is not an active %', p_client_id, case when v_is_delivery then 'merchant' else 'client' end
      using errcode = 'TD010';
  end if;
  if v_is_delivery then
    if p_merchant is null then
      raise exception 'create_order: a delivery needs a merchant' using errcode = '22023';
    end if;
    select m.* into v_merchant from public.merchants m where m.id = p_merchant for share;
    if not found or v_merchant.owner_id is distinct from p_client_id then
      -- a shop that does not exist and a shop that is somebody else's look the same from outside
      raise exception 'create_order: profile % does not own merchant %', p_client_id, p_merchant using errcode = 'TD010';
    end if;
  end if;

  -- 2. rate limit, per PROFILE. The advisory lock makes check-then-insert atomic per profile: without it two
  --    simultaneous requests would both count 4 and both be let through. (Held to the end of the transaction.)
  perform pg_advisory_xact_lock(hashtextextended('create_order:' || p_client_id::text, 0));
  if v_is_delivery then
    v_limit := private.setting_int('orders.delivery_rate_limit_per_10min', 30);
    if v_limit < 1 then
      v_limit := 30;
    end if;
  else
    v_limit := private.setting_int('orders.rate_limit_per_10min', 5);
    if v_limit < 1 then
      v_limit := 5;
    end if;
  end if;
  select count(*) into v_recent from public.orders o
  where o.client_id = p_client_id and o.created_at > v_now - c_window;
  if v_recent >= v_limit then
    raise exception 'create_order: % orders in the last 10 minutes (limit %)', v_recent, v_limit using errcode = 'TD001';
  end if;

  -- 3. sanity ceiling on the distance the server computed: an absurd route must not become an absurd price
  if p_distance_m < 0 then
    raise exception 'create_order: the distance cannot be negative (got % m)', p_distance_m using errcode = '22023';
  end if;
  v_max_distance := private.setting_int('orders.max_distance_m', 20000);
  if v_max_distance < 1 then
    v_max_distance := 20000;
  end if;
  if p_distance_m > v_max_distance then
    raise exception 'create_order: a distance of % m is above the ceiling of % m', p_distance_m, v_max_distance
      using errcode = 'TD009';
  end if;

  -- 4. delivery: the shop must be approved. Its opening hours are NOT a gate (operational information only).
  if v_is_delivery and v_merchant.status <> 'approved' then
    raise exception 'create_order: merchant % does not take orders', p_merchant using errcode = 'TD002';
  end if;

  -- 5. the price, again, on the server, at this instant, with the server's distance
  v_quote := public.quote_order(p_kind, p_pickup, p_dropoff, p_merchant, p_items, v_now, p_distance_m, p_route_source);

  if (v_quote ->> 'blocked')::boolean then
    v_block := v_quote ->> 'blockedCode';
    raise exception using
      errcode = case v_block
        when 'outside_service_hours' then 'TD005'
        when 'zone_not_served' then 'TD006'
        else 'XX000'
      end,
      message = coalesce(v_quote ->> 'blockedReason', v_block, 'blocked'),
      detail = v_block;
  end if;

  v_total := (v_quote ->> 'totalBrl')::numeric;
  v_uyu := (v_quote ->> 'totalUyu')::numeric;
  v_crosses := (v_quote ->> 'crossesBorder')::boolean;

  -- the floor under the distance (the points are valid by now: quote_order checked their shape). A route can be
  -- longer than the straight line, never shorter; 95% minus 100 m leaves room for snapping to the street grid.
  -- A delivery starts at the shop, whose coordinates quote_order has already required.
  v_a_lat := case when v_is_delivery then v_merchant.lat else (p_pickup ->> 'lat')::numeric end;
  v_a_lng := case when v_is_delivery then v_merchant.lng else (p_pickup ->> 'lng')::numeric end;
  v_b_lat := (p_dropoff ->> 'lat')::numeric;
  v_b_lng := (p_dropoff ->> 'lng')::numeric;
  if v_a_lat is not null and v_a_lng is not null then
    v_haversine := 2 * 6371008.8 * asin(least(1, sqrt(
      power(sin(radians((v_b_lat - v_a_lat)::double precision) / 2), 2)
      + cos(radians(v_a_lat::double precision)) * cos(radians(v_b_lat::double precision))
        * power(sin(radians((v_b_lng - v_a_lng)::double precision) / 2), 2)
    )));
    if p_distance_m < v_haversine * 0.95 - 100 then
      raise exception 'create_order: a distance of % m is shorter than the straight line of % m between the points',
        p_distance_m, round(v_haversine) using errcode = 'TD012';
    end if;
  end if;

  if v_crosses and v_is_delivery and not v_merchant.accepts_cross_border then
    raise exception 'create_order: merchant % does not deliver across the border', p_merchant using errcode = 'TD004';
  end if;

  -- 6. the client's number against the server's. `not (<= tolerance)` so that NaN and anything else that is
  --    not a plain small difference fails closed. In pesos there is no tolerance: a different peso amount is
  --    a different price (the rate moved), and the customer must see the new one before agreeing. (A delivery
  --    compares only the BRL fee: see the header.)
  if not (abs(v_total - p_client_total_brl) <= 0.01)
     or (not v_is_delivery and p_payment_method = 'dinheiro_uyu' and p_client_total_uyu is distinct from v_uyu) then
    insert into public.audit_log (actor_id, actor_role, table_name, record_id, action, before, after)
    values (
      p_client_id, v_profile.role, 'orders', null, 'price_mismatch',
      jsonb_build_object('clientTotalBrl', p_client_total_brl, 'clientTotalUyu', p_client_total_uyu),
      jsonb_build_object(
        'serverTotalBrl', v_total, 'serverTotalUyu', v_uyu, 'kind', p_kind, 'merchantId', p_merchant,
        'distanceM', p_distance_m, 'routeSource', p_route_source, 'paymentMethod', p_payment_method,
        'pricingRuleId', v_quote -> 'pricingRuleId', 'breakdown', v_quote -> 'breakdown'
      )
    );
    return jsonb_build_object('ok', false, 'code', 'price_mismatch', 'totalBrl', v_total, 'totalUyu', v_uyu);
  end if;

  -- 6b. a double tap. This profile's own orders only (the advisory lock above serialises them, so the second of two
  --     simultaneous taps sees the first one committed). Same kind, shop, address, bag and total in the window.
  v_dup_window := private.setting_int('orders.duplicate_window_seconds', 8);
  if v_dup_window > 0 then
    select o.code into v_dup_code from public.orders o
    where o.client_id = p_client_id and o.kind = p_kind and o.merchant_id is not distinct from p_merchant
      and o.total_brl = v_total and o.dropoff_address = p_dropoff
      and o.load_description is not distinct from v_load
      and o.created_at > v_now - make_interval(secs => v_dup_window)
    order by o.created_at desc limit 1;
    if v_dup_code is not null then
      raise exception 'create_order: the same order was sent a moment ago' using errcode = 'TD011', detail = v_dup_code;
    end if;
  end if;

  -- 7. payment. The charged currency follows the payment method: pesos in cash for dinheiro_uyu.
  if p_change_for = 'NaN'::numeric then
    raise exception 'create_order: change_for is not a number' using errcode = 'TD008';
  end if;
  v_currency := case when p_payment_method = 'dinheiro_uyu' then 'UYU' else 'BRL' end;
  if v_is_delivery then
    -- what the courier collects from the buyer: the goods, plus the fee when the buyer is the one who pays it
    v_collect := coalesce(p_collect_amount_brl, 0);
    v_owed_brl := v_collect + case when p_delivery_fee_payer = 'client' then v_total else 0 end;
    v_charged := case when v_currency = 'UYU'
      then ceil(round(v_owed_brl * (v_quote ->> 'fxRateUsed')::numeric, 6))
      else v_owed_brl end;
    if p_change_for is not null and (v_charged = 0 or p_change_for < v_charged) then
      raise exception 'create_order: change_for % does not cover the % % to collect', p_change_for, v_currency, v_charged
        using errcode = 'TD008';
    end if;
  else
    v_charged := case when v_currency = 'UYU' then v_uyu else v_total end;
    if p_payment_method = 'dinheiro_uyu' and p_change_for is null then
      raise exception 'create_order: paying in pesos needs change_for (the note the customer will hand over)'
        using errcode = 'TD008';
    end if;
    if p_payment_method = 'pix' and p_change_for is not null then
      raise exception 'create_order: pix takes no change_for' using errcode = 'TD008';
    end if;
    if p_change_for is not null and p_change_for < v_charged then
      raise exception 'create_order: change_for % does not cover the total of % %', p_change_for, v_currency, v_charged
        using errcode = 'TD008';
    end if;
  end if;

  -- 8. write. The origin of a delivery is the shop, from the database, whatever the caller sent.
  v_pickup := case when v_is_delivery
    then jsonb_build_object(
      'merchantId', v_merchant.id, 'name', v_merchant.name, 'address_text', v_merchant.address_text,
      'city', v_merchant.city, 'country', v_merchant.country, 'lat', v_merchant.lat, 'lng', v_merchant.lng)
    else p_pickup
  end;
  v_status := case when v_is_delivery then 'pronto' else 'criado' end;

  -- the code is short and spoken aloud; a collision on the unique index is retried with a new code, any
  -- other unique violation is a real error
  for v_try in 1 .. 8 loop
    begin
      insert into public.orders (
        kind, client_id, merchant_id, pickup_address, dropoff_address, distance_m, route_source, crosses_border,
        pricing_rule_id, pricing_breakdown, total_brl, fx_rate_id, fx_rate_used, currency_charged, total_charged,
        payment_method, change_for, client_notes, status, prepared_at,
        load_description, collect_amount_brl, delivery_fee_payer, delivery_fee_brl
      ) values (
        p_kind, p_client_id, p_merchant, v_pickup, p_dropoff, p_distance_m, p_route_source, v_crosses,
        (v_quote ->> 'pricingRuleId')::uuid,
        v_quote -> 'breakdown', -- ONLY the breakdown: there is no commission anywhere in the price
        v_total, (v_quote ->> 'fxRateId')::uuid, (v_quote ->> 'fxRateUsed')::numeric, v_currency, v_charged,
        p_payment_method, p_change_for, nullif(btrim(p_client_notes), ''), v_status,
        case when v_is_delivery then v_now end,
        v_load, case when v_is_delivery then p_collect_amount_brl end, p_delivery_fee_payer,
        case when v_is_delivery then v_total end
      ) returning id, code into v_order_id, v_code;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint is distinct from 'orders_code_key' or v_try = 8 then
        raise;
      end if;
    end;
  end loop;

  insert into public.order_events (order_id, from_status, to_status, actor_id, actor_role)
  values (v_order_id, null, v_status, p_client_id, v_profile.role);

  -- the caller-facing subset only: no fx internals
  return jsonb_build_object(
    'ok', true, 'orderId', v_order_id, 'code', v_code, 'status', v_status,
    'totalBrl', v_total, 'currencyCharged', v_currency, 'totalCharged', v_charged
  );
end
$$;

comment on function public.create_order(uuid, public.order_kind, jsonb, jsonb, uuid, jsonb, public.payment_method, numeric, numeric, numeric, integer, public.route_source, text, text, numeric, text) is
  'Order creation (spec 7, 5.2 and section 0): rate limit per profile, distance checks, quote_order re-run with the server distance, total comparison (more than R$ 0,01 apart = rejected and logged in audit_log, returned as {ok:false, code:price_mismatch}), frozen price, first order_events row. ride/courier: an active client. delivery: the caller must own the merchant, the pickup is the shop''s stored coordinates, the order is born pronto, and it carries load_description, collect_amount_brl, delivery_fee_payer. Nothing is written to order_commissions. Server only (service_role): it trusts p_client_id and p_distance_m. Every other refusal RAISEs a TDxxx SQLSTATE and undoes everything.';

revoke all on function public.create_order(uuid, public.order_kind, jsonb, jsonb, uuid, jsonb, public.payment_method, numeric, numeric, numeric, integer, public.route_source, text, text, numeric, text)
  from public, anon, authenticated;
grant execute on function public.create_order(uuid, public.order_kind, jsonb, jsonb, uuid, jsonb, public.payment_method, numeric, numeric, numeric, integer, public.route_source, text, text, numeric, text)
  to service_role;
