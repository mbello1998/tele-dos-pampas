-- RLS helpers. Authorization is decided by profiles.role, read through a SECURITY DEFINER function
-- from auth.uid(). It is NEVER read from a JWT claim: user_metadata is editable by the user, and a
-- claim-based check would let any client promote itself.
--
-- WARNING for everyone who writes SQL after this file: `current_role` is a reserved SQL keyword.
-- Unqualified, it returns the *database* role name as text ('authenticated'), not our user_role.
-- Always write public.current_role().

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- The caller's application role, or null when there is no active profile (anonymous, no profile
-- row yet, or status <> 'active'). A blocked or pending account therefore holds no privileges at all.
create function public.current_role() returns public.user_role
language sql stable security definer set search_path = ''
as $$
  select p.role from public.profiles p
  where p.id = (select auth.uid()) and p.status = 'active'
$$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select public.current_role()) = 'admin', false)
$$;

revoke all on function public.current_role(), public.is_admin() from public, anon;
grant execute on function public.current_role(), public.is_admin() to authenticated, service_role;

-- Ownership lookups used by policies. They are SECURITY DEFINER so a policy on table A can consult
-- table B without B's own RLS recursing back into A. They live in the `private` schema, which
-- PostgREST does not expose, so they are not callable as /rpc endpoints.
-- NULL discipline: every comparison is `x = auth.uid()` (never IS NOT DISTINCT FROM), so an ownerless
-- row (owner_id is null) or a session without a sub never matches.

create function private.owned_merchant_ids() returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.id from public.merchants m
  where m.owner_id = (select auth.uid()) and (select public.current_role()) = 'merchant'
$$;

create function private.owns_merchant(p_merchant uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.merchants m
    where m.id = p_merchant and m.owner_id = (select auth.uid()) and (select public.current_role()) = 'merchant'
  )
$$;

create function private.merchant_is_public(p_merchant uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.merchants m where m.id = p_merchant and m.status = 'approved')
$$;

-- Approved fleets owned by the caller (a pending or suspended fleet reads nothing operational).
create function private.owned_fleet_ids() returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select f.id from public.fleets f
  where f.owner_id = (select auth.uid()) and f.status = 'approved' and (select public.current_role()) = 'fleet'
$$;

create function private.fleet_courier_ids() returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select c.profile_id from public.couriers c where c.fleet_id in (select private.owned_fleet_ids())
$$;

-- The city where the caller is enabled as a courier; null unless role = courier and status = approved.
create function private.courier_base_city() returns text
language sql stable security definer set search_path = ''
as $$
  select c.base_city from public.couriers c
  where c.profile_id = (select auth.uid()) and c.status = 'approved' and (select public.current_role()) = 'courier'
$$;

-- City of an order for queue visibility. Contract with the order-creation task: pickup_address carries
-- a 'city' slug; for food orders without one it falls back to the merchant's city. No city => nobody
-- in the queue sees it (fail closed).
create function private.order_city(p_pickup jsonb, p_merchant uuid) returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce(p_pickup ->> 'city', (select m.city from public.merchants m where m.id = p_merchant))
$$;

create function private.item_merchant_id(p_item uuid) returns uuid
language sql stable security definer set search_path = ''
as $$ select i.merchant_id from public.catalog_items i where i.id = p_item $$;

create function private.group_merchant_id(p_group uuid) returns uuid
language sql stable security definer set search_path = ''
as $$
  select i.merchant_id from public.item_option_groups g join public.catalog_items i on i.id = g.item_id where g.id = p_group
$$;

create function private.category_merchant_id(p_category uuid) returns uuid
language sql stable security definer set search_path = ''
as $$ select c.merchant_id from public.catalog_categories c where c.id = p_category $$;

revoke all on function
  private.owned_merchant_ids(), private.owns_merchant(uuid), private.merchant_is_public(uuid),
  private.owned_fleet_ids(), private.fleet_courier_ids(), private.courier_base_city(),
  private.order_city(jsonb, uuid), private.item_merchant_id(uuid), private.group_merchant_id(uuid),
  private.category_merchant_id(uuid)
from public;
grant execute on function
  private.owned_merchant_ids(), private.owns_merchant(uuid), private.merchant_is_public(uuid),
  private.owned_fleet_ids(), private.fleet_courier_ids(), private.courier_base_city(),
  private.order_city(jsonb, uuid), private.item_merchant_id(uuid), private.group_merchant_id(uuid),
  private.category_merchant_id(uuid)
to authenticated, service_role;

-- Column allowlist for direct UPDATEs through the API. RLS decides WHICH rows; this decides WHICH
-- columns. Usage: execute function private.restrict_update_columns('col_a', 'col_b').
-- Anything not listed (including columns added later) is read-only for anon/authenticated sessions
-- unless the actor is admin. It is skipped for other database roles on purpose: SECURITY DEFINER
-- functions (create_order, transition_order) run as the owner and service_role is server-side.
create function private.restrict_update_columns() returns trigger
language plpgsql set search_path = ''
as $$
declare
  col text;
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if (select public.is_admin()) then
    return new;
  end if;
  for col in
    select n.key from jsonb_each(to_jsonb(new)) n
    where n.value is distinct from (to_jsonb(old) -> n.key)
  loop
    if col <> all (tg_argv) then
      raise exception 'column %.% is not writable by this role', tg_table_name, col
        using errcode = '42501';
    end if;
  end loop;
  return new;
end
$$;
revoke all on function private.restrict_update_columns() from public;

-- Generic audit trigger: who (actor and role), what, before and after. SECURITY DEFINER so the insert
-- into audit_log succeeds even though no API role holds an INSERT policy or privilege on it.
create function public.audit_write() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
begin
  if tg_op in ('UPDATE', 'DELETE') then v_old := to_jsonb(old); end if;
  if tg_op in ('INSERT', 'UPDATE') then v_new := to_jsonb(new); end if;
  insert into public.audit_log (actor_id, actor_role, table_name, record_id, action, before, after)
  values (
    (select auth.uid()),
    (select public.current_role()),
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
