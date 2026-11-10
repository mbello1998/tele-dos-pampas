-- Task 6b: the pricing engine. Price and permission live in Postgres, never in the browser: the client sends
-- intent (origin, destination, kind, items) and the server returns the amount.
--
-- Numbered 0021, not 0012: 0012 sorts BEFORE 0013-0020, which are already applied, so a replay from scratch
-- would run this before order_commissions (0019), is_within_service_hours (0010/0020) and the history guards
-- exist.
--
-- THE DISTANCE IS AN INPUT. This Postgres has no HTTP client, and pricing must not hang on an outbound call
-- inside a transaction. src/lib/geo/osrm.ts (routeDistance) computes it ON THE SERVER (OSRM, haversine x 1.35 on
-- failure) and passes p_distance_m and p_route_source. Because the distance is trusted, this function is NOT
-- executable by `authenticated` or `anon`: an API role could otherwise ask for a cheap quote with a fake
-- distance. Callers are the Server Action (service_role) and create_order (SECURITY DEFINER, Task 11), which
-- re-quotes with a server-computed distance and compares.
--
-- CONTRACT (jsonb in / out)
--   p_pickup, p_dropoff  {"city": "quarai"|"artigas", "country": "BR"|"UY", "lat": n, "lng": n}; extra keys ignored.
--                        city and country must agree (quarai=BR, artigas=UY). For kind food p_pickup is IGNORED:
--                        the origin is the merchant's own city, country and coordinates, read from the database.
--   p_items              food only: [{"itemId": uuid, "qty": 1..99, "optionIds": [uuid, ...]}, ...]. Any price,
--                        total or delta the client adds is ignored: every amount is read from catalog_items and
--                        item_options. Rules of the option groups (required, min, max) are enforced here because
--                        they decide the price (a repeated negative-delta option would lower it).
--   returns              the Quote of src/lib/pricing/types.ts (breakdown, totalBrl, pricingRuleId, distanceM,
--                        routeSource, crossesBorder, blocked, blockedReason) PLUS, alongside it:
--                          blockedCode   'outside_service_hours' | 'zone_not_served' | 'item_unavailable' | null
--                          commissionBrl the merchant's commission (food), NEVER inside `breakdown`
--                          fxRateId, fxRate, fxSpreadPct, fxRateUsed, fxStale, totalUyu   (null when blocked)
--
-- THE COMMISSION IS NOT PART OF THE CUSTOMER'S PRICE STRUCTURE. orders.pricing_breakdown has a CHECK
-- (orders_breakdown_no_commission) that rejects the words commission/comiss anywhere in it, and the intent
-- is wider than the regex: no line, under any name, may reveal what the platform takes from the shop.
-- create_order must therefore (1) store ONLY `breakdown` (or the quote with commissionBrl removed) in
-- pricing_breakdown and (2) write commissionBrl to order_commissions in the same transaction.
--
-- Breakdown keys are the ones private.delivery_fee_keys() (0014) sums for fleet_orders, so a fleet owner
-- sees the delivery fee and never the items: base, extra_km, zone_surcharge, night_surcharge, cross_border_fee,
-- passenger_cross_border_fee; plus items_subtotal (food), which that view excludes by design. The minimum fare
-- is a `base` line labelled pricing.min_fare, so it stays inside the delivery fee.

-- ---------------------------------------------------------------------------------------------
-- helper: one breakdown line
-- ---------------------------------------------------------------------------------------------
create or replace function private.quote_line(p_key text, p_amount numeric, p_label text default null) returns jsonb
language sql immutable set search_path = ''
as $$
  select jsonb_build_object('key', p_key, 'labelKey', coalesce(p_label, 'pricing.' || p_key), 'amountBrl', p_amount)
$$;

-- ---------------------------------------------------------------------------------------------
-- helper: validate an endpoint of the trip
-- ---------------------------------------------------------------------------------------------
create or replace function private.quote_point(p_what text, p_point jsonb)
returns table (pt_city text, pt_country text, pt_lat numeric, pt_lng numeric)
language plpgsql immutable set search_path = ''
as $$
declare
  v_city text;
  v_country text;
  v_lat numeric;
  v_lng numeric;
begin
  if p_point is null or jsonb_typeof(p_point) is distinct from 'object' then
    raise exception 'quote_order: % must be an object {city, country, lat, lng}', p_what using errcode = '22023';
  end if;
  -- (typeof of a missing key is NULL, and NULL <> 'string' is NULL, not true: hence IS DISTINCT FROM)
  if jsonb_typeof(p_point -> 'city') is distinct from 'string' or jsonb_typeof(p_point -> 'country') is distinct from 'string' then
    raise exception 'quote_order: % needs a city and a country (text)', p_what using errcode = '22023';
  end if;
  v_city := p_point ->> 'city';
  v_country := p_point ->> 'country';
  -- Slugs of the street dataset, never display names; and the pair must agree, because the border crossing
  -- is decided by it.
  if not ((v_city = 'quarai' and v_country = 'BR') or (v_city = 'artigas' and v_country = 'UY')) then
    raise exception 'quote_order: % has city % and country %, expected quarai/BR or artigas/UY', p_what, v_city, v_country
      using errcode = '22023';
  end if;
  if jsonb_typeof(p_point -> 'lat') is distinct from 'number' or jsonb_typeof(p_point -> 'lng') is distinct from 'number' then
    raise exception 'quote_order: % needs numeric lat and lng', p_what using errcode = '22023';
  end if;
  v_lat := (p_point ->> 'lat')::numeric;
  v_lng := (p_point ->> 'lng')::numeric;
  if v_lat not between -90 and 90 or v_lng not between -180 and 180 then
    raise exception 'quote_order: % has coordinates outside the globe (%, %)', p_what, v_lat, v_lng using errcode = '22023';
  end if;
  return query select v_city, v_country, v_lat, v_lng;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- helper: is a point inside a zone's GeoJSON polygon? Even-odd ray casting, so inner rings are holes.
-- GeoJSON positions are [lng, lat]. Polygon, MultiPolygon and a Feature wrapping either. A malformed
-- geometry RAISES (naming the zone) instead of being skipped: a skipped unserved zone would let orders in.
-- ---------------------------------------------------------------------------------------------
create or replace function private.zone_polygon_contains(p_zone uuid, p_polygon jsonb, p_lat numeric, p_lng numeric)
returns boolean
language plpgsql immutable set search_path = ''
as $$
declare
  v_geom jsonb := p_polygon;
  v_polys jsonb;
  v_poly jsonb;
  v_ring jsonb;
  v_n integer;
  i integer;
  j integer;
  xi numeric;
  yi numeric;
  xj numeric;
  yj numeric;
  v_inside boolean;
begin
  if jsonb_typeof(v_geom) = 'object' and v_geom ->> 'type' = 'Feature' then
    v_geom := v_geom -> 'geometry';
  end if;
  if jsonb_typeof(v_geom) is distinct from 'object' then
    raise exception 'zone % has a malformed polygon: not a GeoJSON geometry', p_zone using errcode = '55000';
  end if;
  v_polys := case v_geom ->> 'type'
    when 'Polygon' then jsonb_build_array(v_geom -> 'coordinates')
    when 'MultiPolygon' then v_geom -> 'coordinates'
  end;
  if jsonb_typeof(v_polys) is distinct from 'array' then
    raise exception 'zone % has a malformed polygon: expected Polygon or MultiPolygon, got %', p_zone, v_geom ->> 'type'
      using errcode = '55000';
  end if;

  for v_poly in select e.value from jsonb_array_elements(v_polys) e loop
    if jsonb_typeof(v_poly) is distinct from 'array' or jsonb_array_length(v_poly) = 0 then
      raise exception 'zone % has a malformed polygon: a polygon needs at least one ring', p_zone using errcode = '55000';
    end if;
    v_inside := false;
    for v_ring in select e.value from jsonb_array_elements(v_poly) e loop
      if jsonb_typeof(v_ring) is distinct from 'array' or jsonb_array_length(v_ring) < 4 then
        raise exception 'zone % has a malformed polygon: a ring needs at least 4 positions', p_zone using errcode = '55000';
      end if;
      v_n := jsonb_array_length(v_ring);
      for i in 0 .. v_n - 1 loop
        if jsonb_typeof(v_ring -> i) is distinct from 'array'
           or jsonb_typeof(v_ring -> i -> 0) is distinct from 'number'
           or jsonb_typeof(v_ring -> i -> 1) is distinct from 'number' then
          raise exception 'zone % has a malformed polygon: position % is not [lng, lat]', p_zone, i using errcode = '55000';
        end if;
      end loop;
      j := v_n - 1;
      for i in 0 .. v_n - 1 loop
        xi := (v_ring -> i ->> 0)::numeric;
        yi := (v_ring -> i ->> 1)::numeric;
        xj := (v_ring -> j ->> 0)::numeric;
        yj := (v_ring -> j ->> 1)::numeric;
        if (yi > p_lat) <> (yj > p_lat) and p_lng < (xj - xi) * (p_lat - yi) / (yj - yi) + xi then
          v_inside := not v_inside;
        end if;
        j := i;
      end loop;
    end loop;
    if v_inside then
      return true;
    end if;
  end loop;
  return false;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- helper: what do the zones of a city say about a point?
--   zh_blocked    inside an unserved zone (it wins over any surcharge)
--   zh_message    that zone's message: its notes, else settings.unserved_zone_message (pt-BR), else a code
--   zh_surcharge  the largest surcharge among the SERVED zones that contain the point
-- Every zone of the city is evaluated (no early exit) so that a malformed polygon is always noticed.
-- ---------------------------------------------------------------------------------------------
create or replace function private.quote_zone_hit(p_city text, p_lat numeric, p_lng numeric)
returns table (zh_blocked boolean, zh_message text, zh_surcharge numeric)
language plpgsql stable set search_path = ''
as $$
declare
  z record;
  v_blocked boolean := false;
  v_message text;
  v_surcharge numeric := 0;
begin
  for z in
    select zz.id, zz.polygon, zz.surcharge_brl, zz.is_served, zz.notes
    from public.zones zz
    where zz.city = p_city and zz.polygon is not null
    order by zz.name, zz.id
  loop
    if private.zone_polygon_contains(z.id, z.polygon, p_lat, p_lng) then
      if not z.is_served then
        if not v_blocked then
          v_message := coalesce(
            nullif(btrim(z.notes), ''),
            (select s.value ->> 'pt-BR' from public.settings s where s.key = 'unserved_zone_message'),
            'zone_not_served'
          );
        end if;
        v_blocked := true;
      else
        v_surcharge := greatest(v_surcharge, z.surcharge_brl);
      end if;
    end if;
  end loop;
  return query select v_blocked, v_message, v_surcharge;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- helper: the items subtotal, from the database only. Raises 22023 on anything that is not a valid basket
-- for this merchant. An unavailable item or option does not raise: it comes back in qi_unavailable (the
-- NAME of the first one) and the caller blocks the quote, because availability changes between building the
-- cart and confirming it.
-- ---------------------------------------------------------------------------------------------
create or replace function private.quote_items(p_merchant uuid, p_items jsonb)
returns table (qi_subtotal numeric, qi_unavailable text)
language plpgsql stable set search_path = ''
as $$
declare
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_line jsonb;
  v_opt_ids jsonb;
  v_opt_id jsonb;
  v_item public.catalog_items%rowtype;
  v_opt record;
  g record;
  v_qty integer;
  v_unit numeric;
  v_seen uuid[];
  v_cnt integer;
  v_min integer;
  v_subtotal numeric := 0;
  v_unavail text;
begin
  -- CASE, not OR: SQL does not promise to stop at the first operand, and jsonb_array_length raises on a non-array
  if p_items is null or not (case when jsonb_typeof(p_items) = 'array' then jsonb_array_length(p_items) > 0 else false end) then
    raise exception 'quote_order: a food order needs at least one item' using errcode = '22023';
  end if;

  for v_line in select e.value from jsonb_array_elements(p_items) e loop
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'quote_order: every item must be an object {itemId, qty, optionIds}' using errcode = '22023';
    end if;
    if jsonb_typeof(v_line -> 'itemId') is distinct from 'string' or (v_line ->> 'itemId') !~* c_uuid then
      raise exception 'quote_order: itemId must be a uuid (got %)', v_line -> 'itemId' using errcode = '22023';
    end if;
    -- qty: a whole JSON number between 1 and 99 (a string, 1.5 or null is a bug or tampering)
    if jsonb_typeof(v_line -> 'qty') is distinct from 'number' or (v_line ->> 'qty') !~ '^[0-9]{1,3}$' then
      raise exception 'quote_order: qty must be a whole number (got %)', v_line -> 'qty' using errcode = '22023';
    end if;
    v_qty := (v_line ->> 'qty')::integer;
    if v_qty not between 1 and 99 then
      raise exception 'quote_order: qty must be between 1 and 99 (got %)', v_qty using errcode = '22023';
    end if;

    select i.* into v_item from public.catalog_items i
    where i.id = (v_line ->> 'itemId')::uuid and i.merchant_id = p_merchant;
    if not found then
      raise exception 'quote_order: item % is not sold by merchant %', v_line ->> 'itemId', p_merchant using errcode = '22023';
    end if;
    if not v_item.is_available then
      v_unavail := coalesce(v_unavail, v_item.name);
    end if;

    v_opt_ids := coalesce(v_line -> 'optionIds', '[]'::jsonb);
    if jsonb_typeof(v_opt_ids) <> 'array' then
      raise exception 'quote_order: optionIds must be an array of uuids' using errcode = '22023';
    end if;
    v_unit := v_item.price_brl;
    v_seen := '{}';
    for v_opt_id in select e.value from jsonb_array_elements(v_opt_ids) e loop
      if jsonb_typeof(v_opt_id) is distinct from 'string' or (v_opt_id #>> '{}') !~* c_uuid then
        raise exception 'quote_order: optionIds must be uuids (got %)', v_opt_id using errcode = '22023';
      end if;
      select o.id, o.name, o.price_delta_brl, o.is_available into v_opt
      from public.item_options o join public.item_option_groups og on og.id = o.group_id
      where o.id = (v_opt_id #>> '{}')::uuid and og.item_id = v_item.id;
      if not found then
        raise exception 'quote_order: option % does not belong to item %', v_opt_id #>> '{}', v_item.id using errcode = '22023';
      end if;
      if v_opt.id = any (v_seen) then
        raise exception 'quote_order: option % was chosen twice for the same item', v_opt.id using errcode = '22023';
      end if;
      v_seen := v_seen || v_opt.id;
      if not v_opt.is_available then
        v_unavail := coalesce(v_unavail, v_opt.name);
      end if;
      v_unit := v_unit + v_opt.price_delta_brl;
    end loop;

    -- group rules: a required group needs at least one choice; min_select and max_select always apply
    for g in
      select og.id, og.name, og.min_select, og.max_select, og.is_required
      from public.item_option_groups og where og.item_id = v_item.id
    loop
      select count(*) into v_cnt from public.item_options o where o.group_id = g.id and o.id = any (v_seen);
      v_min := case when g.is_required then greatest(g.min_select, 1) else g.min_select end;
      if v_cnt < v_min or v_cnt > g.max_select then
        raise exception 'quote_order: group "%" of item "%" needs between % and % choices, got %',
          g.name, v_item.name, v_min, g.max_select, v_cnt using errcode = '22023';
      end if;
    end loop;

    if v_unit < 0 then
      raise exception 'quote_order: item "%" would cost % per unit with its options', v_item.name, v_unit using errcode = '22023';
    end if;
    v_subtotal := v_subtotal + v_unit * v_qty;
  end loop;

  return query select v_subtotal, v_unavail;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- helper: the BRL -> UYU rate for a civil day. Same selection as getEffectiveRate (src/lib/fx/rate.ts):
--   1. the row of the day (a manual override beats the API row, the latest fetch among equals);
--   2. else the latest row BEFORE the day, flagged stale. (The TypeScript reads the latest of any date; a row
--      dated after the quoted day must not price a quote made for an earlier one, which matters when an old
--      quote is recomputed.)
--   3. else settings['fx.fallback_rate'] (a positive number, or a numeric string), else 7.80, spread 0, stale.
-- ---------------------------------------------------------------------------------------------
create or replace function private.quote_fx(p_day date)
returns table (fx_id uuid, fx_rate numeric, fx_spread numeric, fx_stale boolean)
language plpgsql stable set search_path = ''
as $$
declare
  r record;
  v jsonb;
  v_rate numeric;
begin
  select f.id, f.rate, f.spread_pct into r from public.fx_rates f
  where f.pair = 'BRL/UYU' and f.valid_for_date = p_day
  order by f.is_manual_override desc, f.fetched_at desc, f.id limit 1;
  if found then
    return query select r.id, r.rate, r.spread_pct, false;
    return;
  end if;

  select f.id, f.rate, f.spread_pct into r from public.fx_rates f
  where f.pair = 'BRL/UYU' and f.valid_for_date < p_day
  order by f.valid_for_date desc, f.is_manual_override desc, f.fetched_at desc, f.id limit 1;
  if found then
    return query select r.id, r.rate, r.spread_pct, true;
    return;
  end if;

  select s.value into v from public.settings s where s.key = 'fx.fallback_rate';
  v_rate := case
    when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric
    when jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^[0-9]+(\.[0-9]+)?$' then (v #>> '{}')::numeric
  end;
  if v_rate is null or v_rate <= 0 then
    v_rate := 7.80;
  end if;
  return query select null::uuid, v_rate, 0::numeric, true;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- quote_order
-- ---------------------------------------------------------------------------------------------
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
  v_rule public.pricing_rules%rowtype;
  v_crosses boolean;

  v_code text;
  v_reason text;
  v_zone record;
  v_zone_surcharge numeric := 0;
  v_items record;

  v_lines jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_km numeric;
  v_extra numeric;
  v_amount numeric;
  v_items_subtotal numeric := 0;
  v_commission numeric := 0;
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

  -- 2. origin and destination. For food the ORIGIN IS THE MERCHANT, from the database, whatever p_pickup says.
  if p_kind = 'food' then
    if p_merchant is null then
      raise exception 'quote_order: a food order needs a merchant' using errcode = '22023';
    end if;
    select m.* into v_merchant from public.merchants m where m.id = p_merchant;
    if not found then
      raise exception 'quote_order: merchant % does not exist', p_merchant using errcode = '22023';
    end if;
    v_o_city := v_merchant.city;
    v_o_country := v_merchant.country;
    v_o_lat := v_merchant.lat;
    v_o_lng := v_merchant.lng;
  else
    if p_merchant is not null then
      raise exception 'quote_order: a % order has no merchant', p_kind using errcode = '22023';
    end if;
    if p_items is not null
       and not (case when jsonb_typeof(p_items) = 'array' then jsonb_array_length(p_items) = 0 else false end) then
      raise exception 'quote_order: a % order has no items', p_kind using errcode = '22023';
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

  -- 3. the rule IN FORCE at the instant, on the origin city's civil date (not merely the newest row)
  select s.value -> v_o_city ->> 'timezone' into v_tz from public.settings s where s.key = 'service_hours';
  if v_tz is null then
    raise exception 'service_hours has no timezone for city %', v_o_city using errcode = '55000';
  end if;
  v_local := p_at at time zone v_tz;
  select r.* into v_rule from public.pricing_rules r
  where r.city = v_o_city and r.kind = p_kind
    and r.valid_from <= v_local::date and (r.valid_to is null or r.valid_to > v_local::date);
  if not found then
    raise exception 'no pricing_rules version in force for city %, kind % on %', v_o_city, p_kind, v_local::date
      using errcode = '55000';
  end if;

  -- 4. service hours (06:00-00:00, the municipality's rule about the SERVICE; the bridge has no hours).
  --    Both cities of a crossing must be open. The function raises on a malformed window (fail closed), and
  --    anything that is not exactly TRUE is treated as closed.
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

  -- 6. food: the items, priced from the database
  if v_code is null and p_kind = 'food' then
    select * into v_items from private.quote_items(p_merchant, p_items);
    if v_items.qi_unavailable is not null then
      v_code := 'item_unavailable';
      v_reason := v_items.qi_unavailable;
    else
      v_items_subtotal := v_items.qi_subtotal;
      v_commission := round(v_items_subtotal * v_merchant.commission_pct / 100, 2);
    end if;
  end if;

  -- 7. the price, line by line. Each amount is rounded to centavos where it is born, so the lines sum to the
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

    if p_kind = 'food' then
      v_lines := v_lines || private.quote_line('items_subtotal', v_items_subtotal);
      v_total := v_total + v_items_subtotal;
    end if;

    -- 8. pesos: rate of the city's civil day (both cities share UTC-3, as getEffectiveRate does) plus the
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
    'distanceM', p_distance_m,
    'routeSource', p_route_source,
    'crossesBorder', v_crosses,
    'blocked', v_code is not null,
    'blockedReason', v_reason,
    'blockedCode', v_code,
    'commissionBrl', v_commission,
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
  'The pricing engine (spec 7). The distance is an INPUT computed on the server (routeDistance); not executable by authenticated or anon. Returns the Quote of src/lib/pricing/types.ts plus blockedCode, commissionBrl (never inside breakdown: store only `breakdown` in orders.pricing_breakdown and write commissionBrl to order_commissions) and fxRateId/fxRate/fxSpreadPct/fxRateUsed/fxStale/totalUyu. Blocked quotes (service closed, unserved zone, unavailable item) have total 0, an empty breakdown and null fx fields; they do not raise. Malformed input and broken configuration (no rule in force, bad service window, bad zone polygon) raise.';

-- ---------------------------------------------------------------------------------------------
-- privileges: the Server Action (service_role) and create_order (SECURITY DEFINER, owner) only.
-- Supabase's default privileges grant EXECUTE on new public functions to anon and authenticated, and
-- `revoke ... from public` does not remove those explicit grants: they are revoked by name.
-- ---------------------------------------------------------------------------------------------
revoke all on function public.quote_order(public.order_kind, jsonb, jsonb, uuid, jsonb, timestamptz, integer, public.route_source)
  from public, anon, authenticated;
grant execute on function public.quote_order(public.order_kind, jsonb, jsonb, uuid, jsonb, timestamptz, integer, public.route_source)
  to service_role;

revoke all on function
  private.quote_line(text, numeric, text), private.quote_point(text, jsonb),
  private.zone_polygon_contains(uuid, jsonb, numeric, numeric), private.quote_zone_hit(text, numeric, numeric),
  private.quote_items(uuid, jsonb), private.quote_fx(date)
from public, anon, authenticated;
