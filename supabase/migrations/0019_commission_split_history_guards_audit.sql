-- Review round (migration 0019).
--   1. The platform-to-merchant commission leaves the customer-facing price structure.
--   2. fx_rates gets the same unconditional history guard as pricing_rules (0017): no UPDATE, no DELETE,
--      for any role, owner and service_role included.
--   3. TRUNCATE cannot wipe the histories: revoked from service_role and blocked by a statement trigger that
--      also binds the owner (row triggers never fire on TRUNCATE).
--   4. Four more tables get audit triggers (spec 5.2.7), plus the new commission table.

-- ---------------------------------------------------------------------------------------------
-- 1. Commission: not in pricing_breakdown, in its own table visible to merchant and admin only
-- ---------------------------------------------------------------------------------------------
-- pricing_breakdown is shown to the customer line by line (base, kilometres, surcharges, items subtotal,
-- total) so the interface can explain every centavo. The commission is a commercial term between the
-- platform and the shop; commission / items_subtotal would reveal that shop's effective rate to whoever
-- reads the breakdown. RLS filters rows, never columns, and every API role is `authenticated`, so a column
-- on `orders` could not be hidden from the client without hiding it from the merchant and admin too. The
-- commission therefore lives in a one-to-one table whose policies are role-aware.
--
-- Write-side contract (pricing engine and create_order): never put a commission line in pricing_breakdown
-- (the CHECK below makes the insert fail loudly), and write commission_brl to order_commissions in the same
-- transaction as the order, from a SECURITY DEFINER function.
alter table public.orders
  add constraint orders_breakdown_no_commission
  check (pricing_breakdown is null or pricing_breakdown::text !~* '(commission|comiss)');

create table public.order_commissions (
  order_id uuid primary key references public.orders (id) on delete cascade,
  commission_brl numeric(10, 2) not null check (commission_brl >= 0)
);
alter table public.order_commissions enable row level security;
revoke all on public.order_commissions from anon;
revoke truncate, references, trigger on public.order_commissions from authenticated;

-- Merchant: the commission of orders of their own shops, once submitted. Admin: all. Nobody else, and nobody
-- but admin writes (create_order runs as the owner).
create function private.order_in_my_shop(p_order uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.orders o
    where o.id = p_order and o.merchant_id in (select private.owned_merchant_ids()) and o.status <> 'criado'
  )
$$;
revoke all on function private.order_in_my_shop(uuid) from public;
grant execute on function private.order_in_my_shop(uuid) to authenticated, service_role;

create policy order_commissions_select_merchant on public.order_commissions for select to authenticated
  using (private.order_in_my_shop(order_id));
create policy order_commissions_select_admin on public.order_commissions for select to authenticated
  using ((select public.is_admin()));
create policy order_commissions_insert_admin on public.order_commissions for insert to authenticated
  with check ((select public.is_admin()));
create policy order_commissions_update_admin on public.order_commissions for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
-- no DELETE policy: it disappears only with its order, and orders are never deleted.

-- restrict_update_columns() with NO arguments: in a trigger without arguments tg_argv is NULL, and
-- `col <> all (NULL)` is NULL (not true), which would have let every column through. Treat it as an empty allowlist.
create or replace function private.restrict_update_columns() returns trigger
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
    if col <> all (coalesce(tg_argv, '{}'::text[])) then
      raise exception 'column %.% is not writable by this role', tg_table_name, col
        using errcode = '42501';
    end if;
  end loop;
  return new;
end
$$;
revoke all on function private.restrict_update_columns() from public;

-- Frozen for everyone but admin (an empty allowlist means every column is read-only).
create trigger restrict_update_columns before update on public.order_commissions
  for each row execute function private.restrict_update_columns();

-- audit_write(): tables keyed by order_id (order_commissions) get a record id too.
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
    coalesce(v_new ->> 'id', v_new ->> 'profile_id', v_new ->> 'key', v_new ->> 'order_id',
             v_old ->> 'id', v_old ->> 'profile_id', v_old ->> 'key', v_old ->> 'order_id'),
    tg_op,
    v_old,
    v_new
  );
  return null;
end
$$;
revoke all on function public.audit_write() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. fx_rates: history, no UPDATE and no DELETE for anyone (same shape as pricing_rules in 0017, but with
--    no column exception: a rate row is never closed, the next day or an override is a new row)
-- ---------------------------------------------------------------------------------------------
create function private.fx_rates_history_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception 'fx_rates is history: a new rate or a manual override is a new row, never an % of an existing one', tg_op
    using errcode = '42501';
end
$$;
revoke all on function private.fx_rates_history_guard() from public;

create trigger fx_rates_history_guard before update or delete on public.fx_rates
  for each row execute function private.fx_rates_history_guard();

-- ---------------------------------------------------------------------------------------------
-- 3. TRUNCATE: row triggers never fire on it, and the privilege was only revoked from anon and
--    authenticated. Revoke it from service_role as well and add a statement trigger that also binds the owner
--    (including cascaded truncates). audit_log gets the same trigger.
-- ---------------------------------------------------------------------------------------------
create function private.history_no_truncate() returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception '% is history and cannot be truncated', tg_table_name using errcode = '42501';
end
$$;
revoke all on function private.history_no_truncate() from public;

revoke truncate on public.pricing_rules, public.fx_rates, public.audit_log from service_role;
create trigger history_no_truncate before truncate on public.pricing_rules
  for each statement execute function private.history_no_truncate();
create trigger history_no_truncate before truncate on public.fx_rates
  for each statement execute function private.history_no_truncate();
create trigger history_no_truncate before truncate on public.audit_log
  for each statement execute function private.history_no_truncate();

-- ---------------------------------------------------------------------------------------------
-- 4. More audit coverage: option prices, opening hours, fleets (radius ceiling) and the commission
-- ---------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['item_options', 'item_option_groups', 'merchant_hours', 'fleets', 'order_commissions'] loop
    execute format('create trigger audit_write after insert or update or delete on public.%I for each row execute function public.audit_write()', t);
  end loop;
end
$$;
