-- RLS hardening after the Task 5 review.
--   1. current_role() -> app_role(): `current_role` is a reserved SQL keyword, so an unqualified
--      `current_role() <> 'admin'` silently evaluates the DATABASE role ('authenticated') and is
--      always true, a security check that passes with no error. The old name no longer exists, so
--      nothing can resolve to it by accident. Policies reference functions by OID and follow the rename.
--   2. fleet_orders view: a fleet no longer reads `orders` at all. RLS filters rows, not columns, and
--      orders.total_brl / pricing_breakdown carry the items subtotal and the commission of a food
--      order, i.e. the merchant's revenue. The view exposes only operational columns plus the
--      delivery-fee portion of the breakdown.
--   3. merchants_public view: clients no longer read `merchants` (commission_pct is a commercial term
--      between the platform and the shop).
--   4. pending / blocked profiles: app_role() is null for them (no privileges) but they keep reading
--      their OWN profiles row (profiles_select_own has never required a role).
--   5. audit_write() can ignore columns: operational toggles (couriers.is_online / is_available) no
--      longer fill the security audit log.
-- Everything below is written against the objects created in 0008 and 0009 and is idempotent in effect.

-- ---------------------------------------------------------------------------------------------
-- 1. app_role()
-- ---------------------------------------------------------------------------------------------
-- 0008 and 0009 now define app_role() from the start, so on a fresh replay there is nothing to rename.
-- On a database that applied the ORIGINAL 0008 (the live project) the function is still current_role():
-- rename it. Either way the end state is the same, and re-running this is a no-op.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'current_role' and p.pronargs = 0
  ) and not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'app_role' and p.pronargs = 0
  ) then
    alter function public."current_role"() rename to app_role;
  end if;
end
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select public.app_role()) = 'admin', false)
$$;

create or replace function private.owned_merchant_ids() returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.id from public.merchants m
  where m.owner_id = (select auth.uid()) and (select public.app_role()) = 'merchant'
$$;

create or replace function private.owns_merchant(p_merchant uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.merchants m
    where m.id = p_merchant and m.owner_id = (select auth.uid()) and (select public.app_role()) = 'merchant'
  )
$$;

create or replace function private.owned_fleet_ids() returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select f.id from public.fleets f
  where f.owner_id = (select auth.uid()) and f.status = 'approved' and (select public.app_role()) = 'fleet'
$$;

create or replace function private.courier_base_city() returns text
language sql stable security definer set search_path = ''
as $$
  select c.base_city from public.couriers c
  where c.profile_id = (select auth.uid()) and c.status = 'approved' and (select public.app_role()) = 'courier'
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. audit_write(): optional column ignore list (trigger arguments). An UPDATE whose only changed
--    columns are in the list is not logged. INSERT and DELETE are always logged.
-- ---------------------------------------------------------------------------------------------
create or replace function public.audit_write() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
begin
  if tg_op in ('UPDATE', 'DELETE') then v_old := to_jsonb(old); end if;
  if tg_op in ('INSERT', 'UPDATE') then v_new := to_jsonb(new); end if;

  if tg_op = 'UPDATE' and tg_nargs > 0 then
    if exists (select 1 from jsonb_each(v_new) n where n.value is distinct from (v_old -> n.key))
       and not exists (
         select 1 from jsonb_each(v_new) n
         where n.value is distinct from (v_old -> n.key) and n.key <> all (tg_argv)
       )
    then
      return null;
    end if;
  end if;

  insert into public.audit_log (actor_id, actor_role, table_name, record_id, action, before, after)
  values (
    (select auth.uid()),
    (select public.app_role()),
    tg_table_name,
    coalesce(v_new ->> 'id', v_new ->> 'profile_id', v_new ->> 'key', v_old ->> 'id', v_old ->> 'profile_id', v_old ->> 'key'),
    tg_op,
    v_old,
    v_new
  );
  return null;
end
$$;
revoke all on function public.audit_write() from public, anon, authenticated;

drop trigger audit_write on public.couriers;
create trigger audit_write after insert or update or delete on public.couriers
  for each row execute function public.audit_write('is_online', 'is_available');

-- Guard: nothing may still mention the keyword-shadowed name.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and (p.proname = 'current_role' or p.prosrc ~* 'current_role')
  ) then
    raise exception 'a function in public/private still references current_role';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      -- a sub-select's output column keeps the name it was created with: AS "current_role" is a harmless alias
      and regexp_replace(coalesce(qual, '') || coalesce(with_check, ''), 'AS "current_role"', '', 'g') ~* 'current_role'
  ) then
    raise exception 'a policy still references current_role';
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. merchants_public: customer-facing columns of approved shops, for clients only.
--    Owner-privileges view (security_invoker = false) because clients have no policy on `merchants`
--    any more; the WHERE clause IS the access rule. security_barrier stops leaky user predicates
--    from being pushed below it. Read-only: no INSERT/UPDATE/DELETE privilege.
-- ---------------------------------------------------------------------------------------------
drop policy merchants_select_client on public.merchants;

create view public.merchants_public with (security_invoker = false, security_barrier = true) as
select m.id, m.name, m.kind, m.city, m.country, m.address_text, m.lat, m.lng, m.phone,
       m.prep_time_min, m.is_open_manual, m.accepts_cross_border, m.logo_url, m.cover_url
from public.merchants m
where m.status = 'approved' and (select public.app_role()) = 'client';

revoke all on public.merchants_public from public, anon, authenticated, service_role;
grant select on public.merchants_public to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. fleet_orders: what a fleet may know about the orders its couriers served.
--    delivery_fee_brl sums ONLY the delivery lines of pricing_breakdown. Contract with the pricing
--    task: the breakdown is a jsonb array of {key, labelKey, amountBrl} (or an object key -> amount)
--    and delivery lines use the keys below. Any other key (items subtotal, commission, total, service
--    fee, anything new) is excluded by default, so the failure mode of a naming mismatch is a lower
--    fee shown to the fleet, never a leaked merchant figure.
-- ---------------------------------------------------------------------------------------------
create function private.delivery_fee_keys() returns text[]
language sql immutable security definer set search_path = ''
as $$
  select array['base', 'per_km', 'extra_km', 'distance', 'zone', 'zone_surcharge', 'night', 'night_surcharge',
               'cross_border', 'cross_border_fee', 'passenger_cross_border_fee']
$$;

-- SECURITY DEFINER on purpose: a view runs its own query as the view owner, but a plain function called
-- from it still runs as the querying role, which has no EXECUTE on these private helpers.
create function private.delivery_fee_brl(p_breakdown jsonb) returns numeric
language sql immutable security definer set search_path = ''
as $$
  select coalesce(sum(a.amount), 0)::numeric(10, 2)
  from (
    select (e ->> 'amountBrl')::numeric as amount
    from jsonb_array_elements(case when jsonb_typeof(p_breakdown) = 'array' then p_breakdown else '[]'::jsonb end) e
    where e ->> 'key' = any (private.delivery_fee_keys()) and jsonb_typeof(e -> 'amountBrl') = 'number'
    union all
    select (o.value #>> '{}')::numeric
    from jsonb_each(case when jsonb_typeof(p_breakdown) = 'object' then p_breakdown else '{}'::jsonb end) o
    where o.key = any (private.delivery_fee_keys()) and jsonb_typeof(o.value) = 'number'
  ) a
$$;
revoke all on function private.delivery_fee_keys(), private.delivery_fee_brl(jsonb) from public;
-- EXECUTE on a function called inside a view is checked against the QUERYING role, not the view owner.
-- Harmless to grant: `private` is not exposed through the API and the function only maps a jsonb it is handed.
grant execute on function private.delivery_fee_brl(jsonb) to authenticated, service_role;

create view public.fleet_orders with (security_invoker = false, security_barrier = true) as
select o.id, o.code, o.kind, o.status, o.status_updated_at, o.created_at, o.accepted_at, o.prepared_at,
       o.picked_up_at, o.delivered_at, o.cancelled_at, o.pickup_address, o.dropoff_address,
       o.distance_m, o.crosses_border, o.courier_id, o.fleet_id,
       private.delivery_fee_brl(o.pricing_breakdown)::numeric(10, 2) as delivery_fee_brl
from public.orders o
where o.fleet_id in (select private.owned_fleet_ids());

revoke all on public.fleet_orders from public, anon, authenticated, service_role;
grant select on public.fleet_orders to authenticated, service_role;

-- A fleet no longer reads orders directly (total_brl and pricing_breakdown live there).
drop policy orders_select_fleet on public.orders;

-- The timeline of an order carries no money; the fleet keeps reading it for its own orders.
create function private.order_in_my_fleet(p_order uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.orders o where o.id = p_order and o.fleet_id in (select private.owned_fleet_ids())
  )
$$;
revoke all on function private.order_in_my_fleet(uuid) from public;
grant execute on function private.order_in_my_fleet(uuid) to authenticated, service_role;

create policy order_events_select_fleet on public.order_events for select to authenticated
  using (private.order_in_my_fleet(order_id));
