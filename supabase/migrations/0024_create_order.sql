-- Task 11: order creation, the moment a price becomes a commitment.
--
-- Numbered 0024 (0022 and 0023 were reserved for other tasks). It depends on quote_order (0021),
-- order_commissions and the history guards (0019), is_within_service_hours (0010/0020) and orders (0005).
--
-- WHO CALLS THIS. Only the server: the Server Action src/actions/orders.ts, through the service role. NOT
-- `authenticated`, for the same reason quote_order is not (0021): both take p_distance_m, which the Server
-- Action computes with OSRM (src/lib/geo/osrm.ts) because Postgres has no HTTP client. An API role allowed to
-- call this could ask for a trip of 0 metres. The function is SECURITY DEFINER because no API role may insert
-- into orders / order_items / order_events / order_commissions directly (RLS has no INSERT policy for them),
-- and it takes the client's id as an argument because there is no auth.uid() on a service-role call: the
-- Server Action takes the id from the verified session and nowhere else.
--
-- WHAT IT DOES, in one transaction (every failure below RAISEs, which undoes everything):
--   1. the client exists, is a `client` and is active                       TD010
--   2. serialises this client's orders and applies the rate limit           TD001
--      (count of THIS profile's orders in the last 10 minutes against settings['orders.rate_limit_per_10min'],
--      default 5; by profile, never by IP: an IP is shared by a whole phone carrier in a town this size)
--   3. the distance is sane (settings['orders.max_distance_m'], default 20000) TD009
--   4. food: the merchant is approved (TD002) and open at this instant (TD003); the catalog rows that price
--      the order are share-locked so a price edit cannot land between the quote and the snapshot
--   5. quote_order, re-run here with the server's distance; a blocked quote is refused with the engine's own
--      words: service closed TD005, zone not served TD006 (message = that zone's message), item unavailable
--      TD007 (message = the item's NAME); a food order across the border needs merchants.accepts_cross_border
--      TD004
--   6. the client's total is compared with the server's. More than R$ 0,01 apart (or, when paying in pesos, any
--      difference in the peso amount) is REJECTED: audit_log gets a row and the function RETURNS
--      {ok:false, code:'price_mismatch', ...}. It returns instead of raising because a RAISE would roll back
--      the audit row too, and the attempt must be on record. Nothing else has been written by then.
--   7. payment: dinheiro_uyu needs change_for >= the pesos charged, dinheiro_brl's change_for (optional) must
--      cover the reais charged, pix takes none                              TD008
--   8. inserts the order with the FROZEN price (pricing_breakdown holds ONLY the breakdown, never the
--      commission), one order_items row per line with name and unit price snapshots, the commission in
--      order_commissions, and the first order_events row (created, actor_role client)
--
-- THE COMMISSION never leaves the server: the return value is the customer-facing subset.
--
-- SQLSTATEs (class TD, ours): TD001 rate_limited, TD002 merchant_unavailable, TD003 merchant_closed,
-- TD004 cross_border_not_accepted, TD005 outside_service_hours, TD006 zone_not_served, TD007 item_unavailable,
-- TD008 payment_invalid, TD009 distance_too_long, TD010 client_not_allowed. Malformed input keeps the
-- quote_order codes (22004 null, 22023 invalid). The Server Action maps them to the user's language.

-- ---------------------------------------------------------------------------------------------
-- settings: the two knobs this function reads. Admin-editable, not public. Missing, non-numeric or
-- out-of-range values fall back to the default in code, so a bad edit cannot switch the guard off.
-- ---------------------------------------------------------------------------------------------
insert into public.settings (key, value, is_public) values
  ('orders.rate_limit_per_10min', '5', false),
  ('orders.max_distance_m', '20000', false)
on conflict (key) do nothing;

-- a whole number from settings (a JSON number or numeric string), else the default
create or replace function private.setting_int(p_key text, p_default integer) returns integer
language plpgsql stable set search_path = ''
as $$
declare
  v jsonb;
  t text;
begin
  select s.value into v from public.settings s where s.key = p_key;
  t := case jsonb_typeof(v) when 'number' then v #>> '{}' when 'string' then v #>> '{}' end;
  if t ~ '^[0-9]{1,9}$' then
    return t::integer;
  end if;
  return p_default;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- is the shop open at this instant? (spec 6: approved AND is_open_manual AND inside a merchant_hours band)
--   weekday follows extract(dow): 0 = Sunday ... 6 = Saturday, on the merchant CITY's wall clock.
--   A band [opens_at, closes_at) with closes_at < opens_at runs past midnight into the next weekday;
--   opens_at = closes_at is a 24-hour band (the same convention as settings.service_hours).
--   No band at all means closed: an unscheduled shop is not an open shop.
-- ---------------------------------------------------------------------------------------------
create or replace function private.merchant_is_open(p_merchant uuid, p_at timestamptz) returns boolean
language plpgsql stable set search_path = ''
as $$
declare
  m record;
  v_tz text;
  v_local timestamp;
  v_dow integer;
  v_time time;
begin
  select mm.status, mm.is_open_manual, mm.city into m from public.merchants mm where mm.id = p_merchant;
  if not found or m.status <> 'approved' or not m.is_open_manual then
    return false;
  end if;
  select s.value -> m.city ->> 'timezone' into v_tz from public.settings s where s.key = 'service_hours';
  if v_tz is null then
    raise exception 'service_hours has no timezone for city %', m.city using errcode = '55000';
  end if;
  v_local := p_at at time zone v_tz;
  v_dow := extract(dow from v_local)::integer;
  v_time := v_local::time;
  return exists (
    select 1 from public.merchant_hours h
    where h.merchant_id = p_merchant
      and (
        (h.weekday = v_dow and (
          h.opens_at = h.closes_at
          or (h.opens_at < h.closes_at and v_time >= h.opens_at and v_time < h.closes_at)
          or (h.opens_at > h.closes_at and v_time >= h.opens_at)
        ))
        or (h.weekday = (v_dow + 6) % 7 and h.opens_at > h.closes_at and v_time < h.closes_at)
      )
  );
end
$$;

-- ---------------------------------------------------------------------------------------------
-- create_order
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_order(
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
  p_client_notes text default null
) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  c_window constant interval := interval '10 minutes';
  v_now timestamptz := now();
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
  v_line jsonb;
  v_item public.catalog_items%rowtype;
  v_delta numeric;
  v_options jsonb;
  v_qty integer;
  v_unit numeric;
  v_items_total numeric := 0;
  v_expected numeric;
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

  -- 1. who is ordering
  select pr.role, pr.status into v_profile from public.profiles pr where pr.id = p_client_id;
  if not found or v_profile.role is distinct from 'client' or v_profile.status is distinct from 'active' then
    raise exception 'create_order: profile % is not an active client', p_client_id using errcode = 'TD010';
  end if;

  -- 2. rate limit, per PROFILE. The advisory lock makes check-then-insert atomic per client: without it two
  --    simultaneous requests would both count 4 and both be let through. (Held to the end of the transaction.)
  perform pg_advisory_xact_lock(hashtextextended('create_order:' || p_client_id::text, 0));
  v_limit := private.setting_int('orders.rate_limit_per_10min', 5);
  if v_limit < 1 then
    v_limit := 5;
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

  -- 4. food: the shop. (courier and ride have no merchant; quote_order refuses a merchant on them.)
  if p_kind = 'food' then
    if p_merchant is null then
      raise exception 'create_order: a food order needs a merchant' using errcode = '22023';
    end if;
    select m.* into v_merchant from public.merchants m where m.id = p_merchant for share;
    if not found or v_merchant.status <> 'approved' then
      raise exception 'create_order: merchant % does not take orders', p_merchant using errcode = 'TD002';
    end if;
    if private.merchant_is_open(p_merchant, v_now) is distinct from true then
      raise exception 'create_order: merchant % is closed', p_merchant using errcode = 'TD003';
    end if;
    -- The quote and the snapshot below both read the catalog. Share-lock what prices this order so an edit
    -- by the shop cannot land between them (it waits for this transaction instead).
    perform 1 from public.catalog_items ci where ci.merchant_id = p_merchant order by ci.id for share;
    perform 1 from public.item_options o
    where o.group_id in (
      select g.id from public.item_option_groups g join public.catalog_items ci on ci.id = g.item_id
      where ci.merchant_id = p_merchant
    )
    order by o.id for share;
  end if;

  -- 5. the price, again, on the server, at this instant, with the server's distance
  v_quote := public.quote_order(p_kind, p_pickup, p_dropoff, p_merchant, p_items, v_now, p_distance_m, p_route_source);

  if (v_quote ->> 'blocked')::boolean then
    v_block := v_quote ->> 'blockedCode';
    raise exception using
      errcode = case v_block
        when 'outside_service_hours' then 'TD005'
        when 'zone_not_served' then 'TD006'
        when 'item_unavailable' then 'TD007'
        else 'XX000'
      end,
      message = coalesce(v_quote ->> 'blockedReason', v_block, 'blocked'),
      detail = v_block;
  end if;

  v_total := (v_quote ->> 'totalBrl')::numeric;
  v_uyu := (v_quote ->> 'totalUyu')::numeric;
  v_crosses := (v_quote ->> 'crossesBorder')::boolean;

  if v_crosses and p_kind = 'food' and not v_merchant.accepts_cross_border then
    raise exception 'create_order: merchant % does not deliver across the border', p_merchant using errcode = 'TD004';
  end if;

  -- 6. the client's number against the server's. `not (<= tolerance)` so that NaN and anything else that is
  --    not a plain small difference fails closed. In pesos there is no tolerance: a different peso amount is
  --    a different price (the rate moved), and the customer must see the new one before agreeing.
  if not (abs(v_total - p_client_total_brl) <= 0.01)
     or (p_payment_method = 'dinheiro_uyu' and p_client_total_uyu is distinct from v_uyu) then
    insert into public.audit_log (actor_id, actor_role, table_name, record_id, action, before, after)
    values (
      p_client_id, 'client', 'orders', null, 'price_mismatch',
      jsonb_build_object('clientTotalBrl', p_client_total_brl, 'clientTotalUyu', p_client_total_uyu),
      jsonb_build_object(
        'serverTotalBrl', v_total, 'serverTotalUyu', v_uyu, 'kind', p_kind, 'merchantId', p_merchant,
        'distanceM', p_distance_m, 'routeSource', p_route_source, 'paymentMethod', p_payment_method,
        'pricingRuleId', v_quote -> 'pricingRuleId', 'breakdown', v_quote -> 'breakdown'
      )
    );
    return jsonb_build_object('ok', false, 'code', 'price_mismatch', 'totalBrl', v_total, 'totalUyu', v_uyu);
  end if;

  -- 7. payment. The charged currency follows the payment method: pesos in cash for dinheiro_uyu.
  v_currency := case when p_payment_method = 'dinheiro_uyu' then 'UYU' else 'BRL' end;
  v_charged := case when v_currency = 'UYU' then v_uyu else v_total end;
  if p_change_for = 'NaN'::numeric then
    raise exception 'create_order: change_for is not a number' using errcode = 'TD008';
  end if;
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

  -- 8. write. The origin of a food order is the shop, from the database, whatever the client sent.
  v_pickup := case when p_kind = 'food'
    then jsonb_build_object(
      'merchantId', v_merchant.id, 'name', v_merchant.name, 'address_text', v_merchant.address_text,
      'city', v_merchant.city, 'country', v_merchant.country, 'lat', v_merchant.lat, 'lng', v_merchant.lng)
    else p_pickup
  end;

  -- the code is short and spoken aloud; a collision on the unique index is retried with a new code, any
  -- other unique violation is a real error
  for v_try in 1 .. 8 loop
    begin
      insert into public.orders (
        kind, client_id, merchant_id, pickup_address, dropoff_address, distance_m, route_source, crosses_border,
        pricing_rule_id, pricing_breakdown, total_brl, fx_rate_id, fx_rate_used, currency_charged, total_charged,
        payment_method, change_for, client_notes
      ) values (
        p_kind, p_client_id, p_merchant, v_pickup, p_dropoff, p_distance_m, p_route_source, v_crosses,
        (v_quote ->> 'pricingRuleId')::uuid,
        v_quote -> 'breakdown', -- ONLY the breakdown: the commission has its own table
        v_total, (v_quote ->> 'fxRateId')::uuid, (v_quote ->> 'fxRateUsed')::numeric, v_currency, v_charged,
        p_payment_method, p_change_for, nullif(btrim(p_client_notes), '')
      ) returning id, code into v_order_id, v_code;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint is distinct from 'orders_code_key' or v_try = 8 then
        raise;
      end if;
    end;
  end loop;

  if p_kind = 'food' then
    for v_line in
      select e.value from jsonb_array_elements(p_items) with ordinality as e (value, n) order by e.n
    loop
      select ci.* into v_item from public.catalog_items ci where ci.id = (v_line ->> 'itemId')::uuid;
      select coalesce(sum(o.price_delta_brl), 0),
             coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'priceDeltaBrl', o.price_delta_brl)
                                order by o.name, o.id), '[]'::jsonb)
        into v_delta, v_options
      from public.item_options o
      where o.id in (select x.value::uuid from jsonb_array_elements_text(coalesce(v_line -> 'optionIds', '[]'::jsonb)) x);
      v_qty := (v_line ->> 'qty')::integer;
      v_unit := v_item.price_brl + v_delta;
      insert into public.order_items (
        order_id, item_id, name_snapshot, unit_price_brl_snapshot, qty, options_snapshot, line_total_brl
      ) values (v_order_id, v_item.id, v_item.name, v_unit, v_qty, v_options, v_unit * v_qty);
      v_items_total := v_items_total + v_unit * v_qty;
    end loop;

    -- the lines must add up to what the quote charged for items; if they ever do not, nothing is written
    select (l ->> 'amountBrl')::numeric into v_expected
    from jsonb_array_elements(v_quote -> 'breakdown') l where l ->> 'key' = 'items_subtotal';
    if v_items_total is distinct from v_expected then
      raise exception 'create_order: item snapshots add up to % but the quote charged % for items', v_items_total, v_expected
        using errcode = 'XX000';
    end if;
  end if;

  insert into public.order_commissions (order_id, commission_brl)
  values (v_order_id, (v_quote ->> 'commissionBrl')::numeric);

  insert into public.order_events (order_id, from_status, to_status, actor_id, actor_role)
  values (v_order_id, null, 'criado', p_client_id, 'client');

  -- the customer-facing subset only: no commission, no fx internals
  return jsonb_build_object(
    'ok', true, 'orderId', v_order_id, 'code', v_code, 'status', 'criado',
    'totalBrl', v_total, 'currencyCharged', v_currency, 'totalCharged', v_charged
  );
end
$$;

comment on function public.create_order(uuid, public.order_kind, jsonb, jsonb, uuid, jsonb, public.payment_method, numeric, numeric, numeric, integer, public.route_source, text) is
  'Order creation (spec 7 and 5.2): rate limit per profile, merchant and distance checks, quote_order re-run with the server distance, total comparison (more than R$ 0,01 apart = rejected and logged in audit_log, returned as {ok:false, code:price_mismatch}), frozen price, item snapshots, commission in order_commissions, first order_events row. Server only (service_role): it trusts p_client_id and p_distance_m. Every other refusal RAISEs a TDxxx SQLSTATE and undoes everything.';

-- ---------------------------------------------------------------------------------------------
-- privileges: the Server Action (service_role) only. Supabase grants EXECUTE on new public functions to
-- anon and authenticated by default, and `revoke ... from public` does not remove those: by name.
-- ---------------------------------------------------------------------------------------------
revoke all on function public.create_order(uuid, public.order_kind, jsonb, jsonb, uuid, jsonb, public.payment_method, numeric, numeric, numeric, integer, public.route_source, text)
  from public, anon, authenticated;
grant execute on function public.create_order(uuid, public.order_kind, jsonb, jsonb, uuid, jsonb, public.payment_method, numeric, numeric, numeric, integer, public.route_source, text)
  to service_role;

revoke all on function private.setting_int(text, integer), private.merchant_is_open(uuid, timestamptz)
  from public, anon, authenticated;
