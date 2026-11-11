-- 0029: Fatia 1b, passo 1. The marketplace is gone (the owner's correction, spec section 0): shops are not a
-- storefront, they are CUSTOMERS of the delivery service. Three things change here, and none of them deletes data.
--
-- 1. order_kind 'food' is renamed to 'delivery'. What is carried is irrelevant to the model; what defines the kind
--    is who contracts it (the merchant) and where the pickup is (always the merchant's own coordinate).
-- 2. Anonymous browsing of the menu is withdrawn: REVOKE + DROP POLICY on the four catalogue tables that 0028
--    opened to `anon`. `merchants_public` and `merchant_hours` stay open to `anon` (the courier app and the
--    dispatch console still need a shop's name, coordinates and whether it is operating).
-- 3. The functions that named the literal 'food' are re-declared with 'delivery'.
--
-- WHAT THIS MIGRATION DOES NOT DO: it drops no table, no column, and deletes no row. catalog_categories,
-- catalog_items, item_option_groups, item_options and order_items, and merchants.commission_pct, stay in the schema,
-- unreferenced by the app, until the owner approves their removal.
--
-- THE RENAME IS NOT A ROW CHANGE. ALTER TYPE ... RENAME VALUE renames the label in pg_enum, so every row that stores
-- the value (status_transitions, pricing_rules, orders, ...) reads 'delivery' without being touched: pricing_rules and
-- fx_rates reject UPDATE and DELETE (history guards) and are never written here. The label's sort position
-- (enumsortorder) does not change either: nothing in the schema orders by it.

alter type public.order_kind rename value 'food' to 'delivery';

-- ---------------------------------------------------------------------------------------------
-- settings['service_hours'] is keyed by kind name (is_within_service_hours reads value -> city -> kind::text), so
-- the key must follow the label or the municipal 06:00-00:00 window would "have no entry" for 'delivery' and every
-- delivery would fail closed. Same value, new key; only the cities that have the old key are touched.
-- ---------------------------------------------------------------------------------------------
update public.settings s
set value = (
  select jsonb_object_agg(c.key,
    case when jsonb_typeof(c.value) = 'object' and c.value ? 'food'
         then (c.value - 'food') || jsonb_build_object('delivery', c.value -> 'food')
         else c.value end)
  from jsonb_each(s.value) as c
)
where s.key = 'service_hours' and s.value::text like '%"food"%';

-- ---------------------------------------------------------------------------------------------
-- Functions that compare against the literal. A literal in a function body is cast to the enum when the statement
-- runs, so after the rename 'food' would raise 22P02 on the first call. Bodies are unchanged except the literal and
-- the words in comments and error messages. CREATE OR REPLACE keeps each function's owner, grants and comment.
-- ---------------------------------------------------------------------------------------------

-- private.courier_sees_order(p_courier uuid, p_kind order_kind, p_status order_status, p_pickup jsonb, p_merchant uuid)
CREATE OR REPLACE FUNCTION private.courier_sees_order(p_courier uuid, p_kind order_kind, p_status order_status, p_pickup jsonb, p_merchant uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (select private.courier_base_city()) is not null
    and (
      p_courier = (select auth.uid())
      or (
        p_courier is null
        and (
          (p_kind = 'courier' and p_status = 'aguardando_motoboy')
          or (p_kind = 'ride' and p_status = 'criado')
          or (p_kind = 'delivery' and p_status = 'pronto')
        )
        and private.order_city(p_pickup, p_merchant) = (select private.courier_base_city())
      )
    )
$function$;

-- private.quote_items(p_merchant uuid, p_items jsonb)
CREATE OR REPLACE FUNCTION private.quote_items(p_merchant uuid, p_items jsonb)
 RETURNS TABLE(qi_subtotal numeric, qi_unavailable text)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
    raise exception 'quote_order: a delivery order needs at least one item' using errcode = '22023';
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
$function$;

-- public.create_order(p_client_id uuid, p_kind order_kind, p_pickup jsonb, p_dropoff jsonb, p_merchant uuid, p_items jsonb, p_payment_method payment_method, p_change_for numeric, p_client_total_brl numeric, p_client_total_uyu numeric, p_distance_m integer, p_route_source route_source, p_client_notes text)
CREATE OR REPLACE FUNCTION public.create_order(p_client_id uuid, p_kind order_kind, p_pickup jsonb, p_dropoff jsonb, p_merchant uuid, p_items jsonb, p_payment_method payment_method, p_change_for numeric, p_client_total_brl numeric, p_client_total_uyu numeric, p_distance_m integer, p_route_source route_source, p_client_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_dup_window integer;
  v_dup_code text;
  v_a_lat numeric;
  v_a_lng numeric;
  v_b_lat numeric;
  v_b_lng numeric;
  v_haversine numeric;
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

  -- 4. delivery: the shop. (courier and ride have no merchant; quote_order refuses a merchant on them.)
  if p_kind = 'delivery' then
    if p_merchant is null then
      raise exception 'create_order: a delivery order needs a merchant' using errcode = '22023';
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

  -- the floor under the distance (the points are valid by now: quote_order checked their shape). A route can be
  -- longer than the straight line, never shorter; 95% minus 100 m leaves room for snapping to the street grid.
  -- A delivery order starts at the shop; if the shop has no coordinates there is nothing to measure against.
  v_a_lat := case when p_kind = 'delivery' then v_merchant.lat else (p_pickup ->> 'lat')::numeric end;
  v_a_lng := case when p_kind = 'delivery' then v_merchant.lng else (p_pickup ->> 'lng')::numeric end;
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

  if v_crosses and p_kind = 'delivery' and not v_merchant.accepts_cross_border then
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

  -- 6b. a double tap. This client's own orders only (the advisory lock above serialises them, so the second of two
  --     simultaneous taps sees the first one committed). Same kind, shop, address and total in the window.
  v_dup_window := private.setting_int('orders.duplicate_window_seconds', 8);
  if v_dup_window > 0 then
    select o.code into v_dup_code from public.orders o
    where o.client_id = p_client_id and o.kind = p_kind and o.merchant_id is not distinct from p_merchant
      and o.total_brl = v_total and o.dropoff_address = p_dropoff
      and o.created_at > v_now - make_interval(secs => v_dup_window)
    order by o.created_at desc limit 1;
    if v_dup_code is not null then
      raise exception 'create_order: the same order was sent a moment ago' using errcode = 'TD011', detail = v_dup_code;
    end if;
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

  -- 8. write. The origin of a delivery order is the shop, from the database, whatever the client sent.
  v_pickup := case when p_kind = 'delivery'
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

  if p_kind = 'delivery' then
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
$function$;

-- public.quote_order(p_kind order_kind, p_pickup jsonb, p_dropoff jsonb, p_merchant uuid, p_items jsonb, p_at timestamp with time zone, p_distance_m integer, p_route_source route_source)
CREATE OR REPLACE FUNCTION public.quote_order(p_kind order_kind, p_pickup jsonb, p_dropoff jsonb, p_merchant uuid, p_items jsonb, p_at timestamp with time zone, p_distance_m integer, p_route_source route_source)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

  -- 2. origin and destination. For delivery the ORIGIN IS THE MERCHANT, from the database, whatever p_pickup says.
  if p_kind = 'delivery' then
    if p_merchant is null then
      raise exception 'quote_order: a delivery order needs a merchant' using errcode = '22023';
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

  -- 6. delivery: the items, priced from the database
  if v_code is null and p_kind = 'delivery' then
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

    if p_kind = 'delivery' then
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
$function$;

-- public.transition_order(p_order uuid, p_to order_status, p_note text, p_expected_from order_status)
CREATE OR REPLACE FUNCTION public.transition_order(p_order uuid, p_to order_status, p_note text DEFAULT NULL::text, p_expected_from order_status DEFAULT NULL::order_status)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_role public.user_role := (select public.app_role());
  v_note text := nullif(btrim(coalesce(p_note, ''), E' \t\r\n'), '');
  v_o public.orders%rowtype;
  v_city text;
  v_claim boolean := false;
  v_fleet uuid;
begin
  -- No active profile (blocked, pending, not signed in): no privileges at all.
  if v_role is null then
    raise exception 'not allowed to move orders' using errcode = '42501';
  end if;

  -- The lock comes BEFORE any validation: what is validated is the row as it is once every concurrent
  -- mover has committed or rolled back.
  select * into v_o from public.orders o where o.id = p_order for update;
  if not found then
    raise exception 'order % not found', p_order using errcode = 'P0002';
  end if;

  -- The caller's view may be stale (a console tab left open, a courier who tapped a minute ago). A caller that
  -- passes the status it SAW is refused when the order is no longer there, so a late click cannot drag an order
  -- backwards (a delivered order "marked ready" by a tab that still showed it cooking). Optional: null skips it.
  if p_expected_from is not null and p_expected_from <> v_o.status then
    raise exception 'order % is no longer in status % (it is now %)', p_order, p_expected_from, v_o.status
      using errcode = '55000';
  end if;

  if v_role = 'admin' then
    if v_note is null then
      raise exception 'an administrator transition requires a reason' using errcode = '22023';
    end if;
    if p_to = v_o.status then
      raise exception 'order is already in status %', p_to using errcode = '55000';
    end if;
    -- "Any status" means any status of THIS kind's flow. The table is read here only as the vocabulary of the
    -- kind, never as the admin's permissions.
    if not exists (
      select 1 from public.status_transitions t
      where t.kind = v_o.kind and (t.from_status = p_to or t.to_status = p_to)
    ) then
      raise exception 'status % is not part of the % flow', p_to, v_o.kind using errcode = '55000';
    end if;
    if p_to in ('aceito', 'motoboy_chegou', 'coletado', 'em_rota', 'em_viagem', 'entregue', 'finalizado')
       and v_o.courier_id is null then
      raise exception 'status % needs a courier: assign one first', p_to using errcode = '55000';
    end if;
  else
    -- Someone else got there first. This is what the loser of a race sees.
    if v_role = 'courier' and v_o.courier_id is not null and v_o.courier_id <> v_uid then
      raise exception 'order % already has a courier', p_order using errcode = '55000';
    end if;

    if not exists (
      select 1 from public.status_transitions t
      where t.kind = v_o.kind and t.from_status = v_o.status and t.to_status = p_to and t.allowed_role = v_role
    ) then
      raise exception 'transition % -> % is not allowed for role % on a % order', v_o.status, p_to, v_role, v_o.kind
        using errcode = '55000';
    end if;

    if p_to = 'cancelado' and v_note is null then
      raise exception 'cancelling an order requires a reason' using errcode = '22023';
    end if;

    if v_role = 'client' then
      if v_o.client_id is distinct from v_uid then
        raise exception 'not allowed to move this order' using errcode = '42501';
      end if;
    elsif v_role = 'merchant' then
      if not private.owns_merchant(v_o.merchant_id) then
        raise exception 'not allowed to move this order' using errcode = '42501';
      end if;
    elsif v_role = 'courier' then
      if v_o.courier_id is null then
        -- Only the open queue can be claimed: courier/aguardando_motoboy, ride/criado, delivery/pronto.
        if not ((v_o.kind = 'courier' and v_o.status = 'aguardando_motoboy')
                or (v_o.kind = 'ride' and v_o.status = 'criado')
                or (v_o.kind = 'delivery' and v_o.status = 'pronto')) then
          raise exception 'not allowed to move this order' using errcode = '42501';
        end if;
        -- ...and only by an approved courier of the pickup city.
        v_city := private.order_city(v_o.pickup_address, v_o.merchant_id);
        if v_city is null or private.courier_base_city() is distinct from v_city then
          raise exception 'courier is not approved in the city of this order' using errcode = '42501';
        end if;
        v_claim := true;
        -- The fleet is copied from the courier: null for an independent courier, whose fee is entirely theirs.
        select c.fleet_id into v_fleet from public.couriers c where c.profile_id = v_uid;
      end if;
    else
      raise exception 'not allowed to move this order' using errcode = '42501';
    end if;
  end if;

  update public.orders o set
    status = p_to,
    status_updated_at = now(),
    courier_id = case when v_claim then v_uid else o.courier_id end,
    fleet_id = case when v_claim then v_fleet else o.fleet_id end,
    accepted_at = case when v_claim or p_to = 'aceito' then coalesce(o.accepted_at, now()) else o.accepted_at end,
    prepared_at = case when p_to = 'pronto' then now() else o.prepared_at end,
    picked_up_at = case when p_to = 'coletado' then now() else o.picked_up_at end,
    delivered_at = case
      when p_to in ('entregue', 'finalizado') then now()
      when o.status in ('entregue', 'finalizado') then null
      else o.delivered_at end,
    -- Cancelling records the reason and the actor. Leaving 'cancelado' (admin only) clears them from the row,
    -- because they no longer describe the order; the cancellation itself stays in order_events.
    cancelled_at = case when p_to = 'cancelado' then now() when o.status = 'cancelado' then null else o.cancelled_at end,
    cancel_reason = case when p_to = 'cancelado' then v_note when o.status = 'cancelado' then null else o.cancel_reason end,
    cancelled_by = case when p_to = 'cancelado' then v_uid when o.status = 'cancelado' then null else o.cancelled_by end
  where o.id = v_o.id;

  insert into public.order_events (order_id, from_status, to_status, actor_id, actor_role, note)
  values (v_o.id, v_o.status, p_to, v_uid, v_role, v_note);
end
$function$;

-- ---------------------------------------------------------------------------------------------
-- The shops are no longer a storefront: `anon` stops reading the menu. REVOKE and DROP POLICY only.
-- A table-level REVOKE also removes the column-level SELECT grants 0028 gave (documented PostgreSQL behaviour).
-- The policies for the signed-in roles (client, owner, admin) are left as they were; they go with the tables.
-- ---------------------------------------------------------------------------------------------
drop policy catalog_categories_select_anon on public.catalog_categories;
drop policy catalog_items_select_anon on public.catalog_items;
drop policy item_option_groups_select_anon on public.item_option_groups;
drop policy item_options_select_anon on public.item_options;

revoke all on public.catalog_categories, public.catalog_items, public.item_option_groups, public.item_options from anon;

-- The two helpers only those policies called. merchant_is_public stays: merchant_hours_select_anon still uses it.
revoke execute on function private.item_merchant_id(uuid), private.group_merchant_id(uuid) from anon;
