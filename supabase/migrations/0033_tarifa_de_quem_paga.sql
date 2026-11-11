-- 0033: a tarifa e de QUEM PAGA, nao de quem chamou.
--
-- Decisao do dono em 11/11/2026, nas palavras dele: "o comprador paga 9". A 0031 cobrava a tarifa de convenio
-- (R$ 8) em toda entrega pedida por uma loja, inclusive quando quem pagava a entrega era o comprador. Estava
-- errado: o convenio e um desconto que a LOJA ganha por ser conveniada, e nao um desconto que ela repasse.
--
--   entrega, a LOJA paga      -> tarifa de convenio, R$ 8,00
--   entrega, o COMPRADOR paga -> tarifa de balcao,   R$ 9,00
--   mototaxi e encomenda      -> tarifa de balcao (nao existe convenio)
--
-- quote_order ganha p_fee_payer, SEM DEFAULT: preco e dinheiro, e um default silencioso cobraria do lado errado
-- se um chamador esquecesse de dizer. Por isso a assinatura antiga de 8 argumentos CAI (um `create or replace`
-- com argumento novo criaria uma sobrecarga, e uma chamada ambigua). Nenhuma tabela e nenhum dado sao tocados.
--
-- Nada muda nas linhas de pricing_rules: as duas tarifas ja existem desde a 0031. O que muda e qual delas a
-- funcao escolhe.

drop function if exists public.quote_order(public.order_kind, jsonb, jsonb, uuid, jsonb, timestamptz, integer, public.route_source);

create or replace function public.quote_order(
  p_kind public.order_kind,
  p_pickup jsonb,
  p_dropoff jsonb,
  p_merchant uuid,
  p_items jsonb,
  p_at timestamptz,
  p_distance_m integer,
  p_route_source public.route_source
,
  -- QUEM PAGA decide a TARIFA (0033). Sem default de proposito: preco e dinheiro, e um default
  -- silencioso aqui cobraria do lado errado se um chamador esquecesse de dizer.
  p_fee_payer text
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
  if p_fee_payer is null or p_fee_payer not in ('client', 'merchant') then
    raise exception 'quote_order: p_fee_payer must be client or merchant' using errcode = '22023';
  end if;
  -- A TARIFA E DE QUEM PAGA, NAO DE QUEM CHAMOU (decisao do dono, 11/11/2026). Uma entrega pedida pela loja
  -- sai na tarifa de convenio (R$ 8) quando a LOJA paga, e na tarifa de balcao (R$ 9) quando quem paga e o
  -- comprador: o convenio e um desconto que a loja ganha por ser conveniada, e nao um desconto que ela possa
  -- repassar ao comprador. Mototaxi e encomenda nao tem convenio: sempre balcao.
  v_audience := case when p_kind = 'delivery' and p_fee_payer = 'merchant' then 'merchant' else 'client' end;
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

comment on function public.quote_order(public.order_kind, jsonb, jsonb, uuid, jsonb, timestamptz, integer, public.route_source, text) is
  'The pricing engine (spec 7). The distance is an INPUT computed on the server (routeDistance); not executable by authenticated or anon. p_fee_payer (client|merchant, required) chooses the TARIFF: a delivery paid by the shop prices on the merchant (agreement) tariff, a delivery paid by the buyer and every other kind on the client (counter) tariff. A delivery starts at the shop''s stored coordinates and carries no items. Returns the Quote of src/lib/pricing/types.ts plus audience, blockedCode and fxRateId/fxRate/fxSpreadPct/fxRateUsed/fxStale/totalUyu. There is no commission. Blocked quotes (service closed, unserved zone) have total 0, an empty breakdown and null fx fields; they do not raise. Malformed input and broken configuration (no rule in force, bad service window, bad zone polygon) raise.';

revoke all on function public.quote_order(public.order_kind, jsonb, jsonb, uuid, jsonb, timestamptz, integer, public.route_source, text) from public, anon, authenticated;
grant execute on function public.quote_order(public.order_kind, jsonb, jsonb, uuid, jsonb, timestamptz, integer, public.route_source, text) to service_role;


-- ---------------------------------------------------------------------------------------------
-- create_order, so para passar quem paga adiante. Nada mais muda: o resto do corpo e o da 0031.
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
  -- Quem paga vai junto: e ele que escolhe a tarifa (0033). Fora de delivery nao ha convenio, entao 'client'.
  v_quote := public.quote_order(
    p_kind, p_pickup, p_dropoff, p_merchant, p_items, v_now, p_distance_m, p_route_source,
    case when v_is_delivery then p_delivery_fee_payer else 'client' end);

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
