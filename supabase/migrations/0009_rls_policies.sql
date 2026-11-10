-- Row Level Security policies. Security is RLS, not a hidden route: every rule below is enforced by
-- Postgres even when the caller holds a valid token.
--
-- Model
--   * Role = profiles.role via public.current_role() (security definer), never a JWT claim.
--   * Default deny: RLS is enabled on every table (0001..0006); a table with no policy for a role is
--     invisible to it. anon holds no table privilege except SELECT on settings (see "Privileges").
--   * Policies are PERMISSIVE and OR together; each is scoped `to authenticated` (or anon) and names
--     the table, operation and role: <table>_<operation>_<role>.
--   * Ownership comparisons are `col = auth.uid()` only. A NULL owner or a missing sub never matches.
--   * Two businesses, two silos: `merchant` and `fleet` never see each other's money. merchant never
--     reads couriers, fleets or positions; fleet never reads merchants, catalog or order_items.
--   * Money and state columns are write-protected by trigger (private.restrict_update_columns, below)
--     in addition to the row policies: RLS cannot see columns, the trigger can.
--   * orders / order_items / order_events are INSERTed only by SECURITY DEFINER functions
--     (create_order, transition_order) or by admin. No API role inserts a priced order directly.
--
-- Shorthand used in every policy:  (select auth.uid())  and  (select public.current_role())
-- are wrapped in a sub-select so Postgres evaluates them once per statement, not once per row.

-- =============================================================================================
-- Privileges: RLS is the guard, but table privileges are a second wall where cheap.
-- =============================================================================================
revoke all on all tables in schema public from anon;
grant select on public.settings to anon;                           -- public settings only (RLS filters is_public)
alter default privileges in schema public revoke all on tables from anon; -- future tables start closed to anon too
revoke truncate, references, trigger on all tables in schema public from anon, authenticated; -- TRUNCATE ignores RLS

-- audit_log is append-only for every API role. No UPDATE, DELETE, TRUNCATE or INSERT privilege for
-- anyone, admin included; rows enter only through public.audit_write() (security definer).
revoke all on public.audit_log from anon, authenticated, service_role;
grant select on public.audit_log to authenticated, service_role;

-- =============================================================================================
-- settings: anon and everyone read public keys; admin reads and writes all
-- =============================================================================================
create policy settings_select_public on public.settings for select to anon, authenticated
  using (is_public);

-- =============================================================================================
-- audit_log: the ONLY policy is SELECT for admin. There is deliberately no INSERT, UPDATE or DELETE
-- policy, so even if a privilege were granted by mistake RLS would still refuse. Inserts happen in
-- public.audit_write(), which runs as the table owner (security definer) and is not subject to API RLS.
-- =============================================================================================
create policy audit_log_select_admin on public.audit_log for select to authenticated
  using ((select public.is_admin()));

-- =============================================================================================
-- Reference data readable by signed-in roles
-- =============================================================================================
-- Transition table: every active role reads it (the dispatch console draws only the buttons the role may press).
create policy status_transitions_select_active on public.status_transitions for select to authenticated
  using ((select public.current_role()) is not null);

create policy zones_select_active on public.zones for select to authenticated
  using ((select public.current_role()) is not null);

create policy fx_rates_select_active on public.fx_rates for select to authenticated
  using ((select public.current_role()) is not null);

-- Delivery tariff: those who pay or earn it. merchant is NOT in the list (not their money, not their table).
create policy pricing_rules_select_client_courier_fleet on public.pricing_rules for select to authenticated
  using ((select public.current_role()) in ('client', 'courier', 'fleet'));

-- =============================================================================================
-- profiles
-- =============================================================================================
create policy profiles_select_own on public.profiles for select to authenticated
  using (id = (select auth.uid()));

-- A fleet owner reads the profiles (name, phone) of the couriers in their approved fleet, nobody else's.
create policy profiles_select_fleet_couriers on public.profiles for select to authenticated
  using ((select public.current_role()) = 'fleet' and id in (select private.fleet_courier_ids()));

-- Self-registration as a plain client only; role/status can never be chosen by the caller.
create policy profiles_insert_own_client on public.profiles for insert to authenticated
  with check (id = (select auth.uid()) and role = 'client' and status = 'active');

-- Own row, active accounts only. Which COLUMNS may change is the trigger's job (role/status are not allowed).
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid()) and (select public.current_role()) is not null)
  with check (id = (select auth.uid()));

-- =============================================================================================
-- fleets
-- =============================================================================================
create policy fleets_select_owner on public.fleets for select to authenticated
  using ((select public.current_role()) = 'fleet' and owner_id = (select auth.uid()));

create policy fleets_update_owner on public.fleets for update to authenticated
  using ((select public.current_role()) = 'fleet' and owner_id = (select auth.uid()))
  with check ((select public.current_role()) = 'fleet' and owner_id = (select auth.uid()));
-- insert/delete: admin only (fleets are created and approved by the platform)

-- =============================================================================================
-- couriers
-- =============================================================================================
create policy couriers_select_own on public.couriers for select to authenticated
  using ((select public.current_role()) = 'courier' and profile_id = (select auth.uid()));

create policy couriers_select_fleet on public.couriers for select to authenticated
  using (fleet_id in (select private.owned_fleet_ids()));

create policy couriers_update_own on public.couriers for update to authenticated
  using ((select public.current_role()) = 'courier' and profile_id = (select auth.uid()))
  with check ((select public.current_role()) = 'courier' and profile_id = (select auth.uid()));

create policy couriers_update_fleet on public.couriers for update to authenticated
  using (fleet_id in (select private.owned_fleet_ids()))
  with check (fleet_id in (select private.owned_fleet_ids()));
-- insert/delete: admin only. status, fleet_id and base_city are admin-only columns (trigger).
-- merchant: no policy at all, so couriers are invisible to merchants.

-- =============================================================================================
-- merchants and their catalog
-- Readers: signed-in clients (approved shops only), the owning merchant, admin.
-- Not readers: courier, fleet, other merchants, and EVERYONE when owner_id is null (only admin).
-- =============================================================================================
create policy merchants_select_client on public.merchants for select to authenticated
  using ((select public.current_role()) = 'client' and status = 'approved');

create policy merchants_select_owner on public.merchants for select to authenticated
  using ((select public.current_role()) = 'merchant' and owner_id = (select auth.uid()));

create policy merchants_update_owner on public.merchants for update to authenticated
  using ((select public.current_role()) = 'merchant' and owner_id = (select auth.uid()))
  with check ((select public.current_role()) = 'merchant' and owner_id = (select auth.uid()));
-- insert/delete: admin only. status, owner_id, commission_pct, city, country, kind are admin-only columns (trigger).

create policy merchant_hours_select_client on public.merchant_hours for select to authenticated
  using ((select public.current_role()) = 'client' and private.merchant_is_public(merchant_id));
create policy merchant_hours_select_owner on public.merchant_hours for select to authenticated
  using (private.owns_merchant(merchant_id));
create policy merchant_hours_insert_owner on public.merchant_hours for insert to authenticated
  with check (private.owns_merchant(merchant_id));
create policy merchant_hours_update_owner on public.merchant_hours for update to authenticated
  using (private.owns_merchant(merchant_id)) with check (private.owns_merchant(merchant_id));
create policy merchant_hours_delete_owner on public.merchant_hours for delete to authenticated
  using (private.owns_merchant(merchant_id));

create policy catalog_categories_select_client on public.catalog_categories for select to authenticated
  using ((select public.current_role()) = 'client' and private.merchant_is_public(merchant_id));
create policy catalog_categories_select_owner on public.catalog_categories for select to authenticated
  using (private.owns_merchant(merchant_id));
create policy catalog_categories_insert_owner on public.catalog_categories for insert to authenticated
  with check (private.owns_merchant(merchant_id));
create policy catalog_categories_update_owner on public.catalog_categories for update to authenticated
  using (private.owns_merchant(merchant_id)) with check (private.owns_merchant(merchant_id));
create policy catalog_categories_delete_owner on public.catalog_categories for delete to authenticated
  using (private.owns_merchant(merchant_id));

-- An item may only point at a category of the SAME shop.
create policy catalog_items_select_client on public.catalog_items for select to authenticated
  using ((select public.current_role()) = 'client' and private.merchant_is_public(merchant_id));
create policy catalog_items_select_owner on public.catalog_items for select to authenticated
  using (private.owns_merchant(merchant_id));
create policy catalog_items_insert_owner on public.catalog_items for insert to authenticated
  with check (
    private.owns_merchant(merchant_id)
    and (category_id is null or private.category_merchant_id(category_id) = merchant_id)
  );
create policy catalog_items_update_owner on public.catalog_items for update to authenticated
  using (private.owns_merchant(merchant_id))
  with check (
    private.owns_merchant(merchant_id)
    and (category_id is null or private.category_merchant_id(category_id) = merchant_id)
  );
create policy catalog_items_delete_owner on public.catalog_items for delete to authenticated
  using (private.owns_merchant(merchant_id));

create policy item_option_groups_select_client on public.item_option_groups for select to authenticated
  using ((select public.current_role()) = 'client' and private.merchant_is_public(private.item_merchant_id(item_id)));
create policy item_option_groups_select_owner on public.item_option_groups for select to authenticated
  using (private.owns_merchant(private.item_merchant_id(item_id)));
create policy item_option_groups_insert_owner on public.item_option_groups for insert to authenticated
  with check (private.owns_merchant(private.item_merchant_id(item_id)));
create policy item_option_groups_update_owner on public.item_option_groups for update to authenticated
  using (private.owns_merchant(private.item_merchant_id(item_id)))
  with check (private.owns_merchant(private.item_merchant_id(item_id)));
create policy item_option_groups_delete_owner on public.item_option_groups for delete to authenticated
  using (private.owns_merchant(private.item_merchant_id(item_id)));

create policy item_options_select_client on public.item_options for select to authenticated
  using ((select public.current_role()) = 'client' and private.merchant_is_public(private.group_merchant_id(group_id)));
create policy item_options_select_owner on public.item_options for select to authenticated
  using (private.owns_merchant(private.group_merchant_id(group_id)));
create policy item_options_insert_owner on public.item_options for insert to authenticated
  with check (private.owns_merchant(private.group_merchant_id(group_id)));
create policy item_options_update_owner on public.item_options for update to authenticated
  using (private.owns_merchant(private.group_merchant_id(group_id)))
  with check (private.owns_merchant(private.group_merchant_id(group_id)));
create policy item_options_delete_owner on public.item_options for delete to authenticated
  using (private.owns_merchant(private.group_merchant_id(group_id)));

-- =============================================================================================
-- addresses: whoever owns the row, while the account is active
-- =============================================================================================
create policy addresses_select_own on public.addresses for select to authenticated
  using (profile_id = (select auth.uid()) and (select public.current_role()) is not null);
create policy addresses_insert_own on public.addresses for insert to authenticated
  with check (profile_id = (select auth.uid()) and (select public.current_role()) is not null);
create policy addresses_update_own on public.addresses for update to authenticated
  using (profile_id = (select auth.uid()) and (select public.current_role()) is not null)
  with check (profile_id = (select auth.uid()));
create policy addresses_delete_own on public.addresses for delete to authenticated
  using (profile_id = (select auth.uid()) and (select public.current_role()) is not null);

-- =============================================================================================
-- orders
--   client   own orders
--   courier  (a) orders assigned to them, (b) the OPEN queue of the city where they are approved:
--            courier_id is null, a status that is waiting for a courier, same pickup city
--   merchant orders of their own shops, once submitted (status <> 'criado')
--   fleet    orders served by their approved fleet (orders.fleet_id, copied at accept time)
--   admin    everything
-- There is no INSERT or DELETE policy for any API role but admin (INSERT) and none for DELETE at all:
-- an order is created by create_order() with a server-computed price, moved by transition_order(),
-- and never deleted. Direct UPDATE is limited to the client's free-text columns (trigger).
-- =============================================================================================
create policy orders_select_client on public.orders for select to authenticated
  using (client_id = (select auth.uid()) and (select public.current_role()) is not null);

create policy orders_select_courier on public.orders for select to authenticated
  using (
    (select private.courier_base_city()) is not null
    and (
      courier_id = (select auth.uid())
      or (
        courier_id is null
        and (
          (kind = 'courier' and status = 'aguardando_motoboy')
          or (kind = 'ride' and status = 'criado')
          or (kind = 'food' and status = 'pronto')
        )
        and private.order_city(pickup_address, merchant_id) = (select private.courier_base_city())
      )
    )
  );

create policy orders_select_merchant on public.orders for select to authenticated
  using (merchant_id in (select private.owned_merchant_ids()) and status <> 'criado');

create policy orders_select_fleet on public.orders for select to authenticated
  using (fleet_id in (select private.owned_fleet_ids()));

create policy orders_update_client on public.orders for update to authenticated
  using (client_id = (select auth.uid()) and (select public.current_role()) is not null)
  with check (client_id = (select auth.uid()));

-- order_items: the lines of a sale are the merchant's revenue. client (own order), merchant (own shop)
-- and the courier carrying that order. NOT fleet, NOT the courier queue.
create policy order_items_select_client on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_items.order_id and o.client_id = (select auth.uid())));

create policy order_items_select_merchant on public.order_items for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_items.order_id and o.merchant_id in (select private.owned_merchant_ids()) and o.status <> 'criado'
  ));

create policy order_items_select_courier on public.order_items for select to authenticated
  using (
    (select private.courier_base_city()) is not null
    and exists (select 1 from public.orders o where o.id = order_items.order_id and o.courier_id = (select auth.uid()))
  );

-- order_events: the timeline. Whoever may read the order (through orders' own RLS) may read its events.
create policy order_events_select_visible_order on public.order_events for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_events.order_id));

-- =============================================================================================
-- courier_positions
-- Courier: publishes and reads their own, only against an order they carry (or none).
-- The privacy rule for clients and fleets (active order only) is Task 12's policy; until then
-- only the courier and admin can read positions.
-- =============================================================================================
create policy courier_positions_select_own on public.courier_positions for select to authenticated
  using (courier_id = (select auth.uid()) and (select private.courier_base_city()) is not null);

create policy courier_positions_insert_own on public.courier_positions for insert to authenticated
  with check (
    courier_id = (select auth.uid())
    and (select private.courier_base_city()) is not null
    and (
      order_id is null
      or exists (select 1 from public.orders o where o.id = courier_positions.order_id and o.courier_id = (select auth.uid()))
    )
  );

-- =============================================================================================
-- Admin: every table, per operation. Exceptions on purpose:
--   audit_log                      select only (above)
--   orders, order_items            select, insert, update (financial record: no delete)
--   order_events                   select, insert (append-only timeline)
-- =============================================================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'fleets', 'couriers', 'merchants', 'merchant_hours', 'catalog_categories', 'catalog_items',
    'item_option_groups', 'item_options', 'addresses', 'zones', 'courier_positions',
    'pricing_rules', 'fx_rates', 'settings', 'status_transitions',
    'orders', 'order_items', 'order_events'
  ] loop
    execute format('create policy %I on public.%I for select to authenticated using ((select public.is_admin()))', t || '_select_admin', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select public.is_admin()))', t || '_insert_admin', t);
  end loop;
  foreach t in array array[
    'profiles', 'fleets', 'couriers', 'merchants', 'merchant_hours', 'catalog_categories', 'catalog_items',
    'item_option_groups', 'item_options', 'addresses', 'zones', 'courier_positions',
    'pricing_rules', 'fx_rates', 'settings', 'status_transitions',
    'orders', 'order_items'
  ] loop
    execute format('create policy %I on public.%I for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))', t || '_update_admin', t);
  end loop;
  foreach t in array array[
    'profiles', 'fleets', 'couriers', 'merchants', 'merchant_hours', 'catalog_categories', 'catalog_items',
    'item_option_groups', 'item_options', 'addresses', 'zones', 'courier_positions',
    'pricing_rules', 'fx_rates', 'settings', 'status_transitions'
  ] loop
    execute format('create policy %I on public.%I for delete to authenticated using ((select public.is_admin()))', t || '_delete_admin', t);
  end loop;
end
$$;

-- =============================================================================================
-- Column guards (second layer behind the row policies). A direct UPDATE by anon/authenticated that
-- touches a column outside the allowlist is refused with 42501 unless the actor is admin. Columns
-- added in the future are read-only by default. Server paths (security definer functions run as
-- the owner, service_role) are not affected.
-- =============================================================================================
create trigger restrict_update_columns before update on public.profiles
  for each row execute function private.restrict_update_columns('full_name', 'phone', 'locale', 'currency_pref', 'home_city', 'country');

create trigger restrict_update_columns before update on public.couriers
  for each row execute function private.restrict_update_columns('vehicle', 'plate', 'accepts_cross_border', 'accepts_passenger', 'is_online');

create trigger restrict_update_columns before update on public.fleets
  for each row execute function private.restrict_update_columns('name', 'phone');

create trigger restrict_update_columns before update on public.merchants
  for each row execute function private.restrict_update_columns(
    'name', 'address_text', 'lat', 'lng', 'phone', 'prep_time_min', 'is_open_manual', 'accepts_cross_border', 'logo_url', 'cover_url');

-- orders: only the client's free-text columns. total_brl, total_charged, pricing_breakdown, fx_rate_used,
-- fx_rate_id, pricing_rule_id, currency_charged, status, courier_id, fleet_id... all frozen to non-admins.
create trigger restrict_update_columns before update on public.orders
  for each row execute function private.restrict_update_columns('client_notes', 'rating', 'rating_comment');

-- =============================================================================================
-- Audit: actor, role, before and after, on every sensitive table (AFTER, row level).
-- =============================================================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'pricing_rules', 'fx_rates', 'settings', 'merchants', 'catalog_items', 'catalog_categories',
    'couriers', 'zones', 'profiles'
  ] loop
    execute format('create trigger audit_write after insert or update or delete on public.%I for each row execute function public.audit_write()', t);
  end loop;
end
$$;
