-- 0028: browsing the shops is public. Ordering stays authenticated.
--
-- A menu is public information, and nobody creates an account to learn what a trailer sells: in every delivery app
-- you browse first and sign in to order. So `anon` (no session) may READ what a customer sees on the shop list and
-- the menu. Nothing else changes.
--
-- WHAT OPENS (read-only, `anon`):
--   merchants_public    the customer-facing view of approved shops (view below is redefined, same columns)
--   catalog_categories, catalog_items, item_option_groups, item_options, merchant_hours
--                       only rows of an APPROVED merchant (the same rule the `client` policies already use)
--   public.is_within_service_hours(...)  the municipal 06:00-00:00 window, so "open now" can be computed
--
-- WHAT STAYS CLOSED (untouched here):
--   `merchants` (carries commission_pct, the platform's commercial term with each shop: the whole reason
--   merchants_public exists), orders, order_items, order_events, order_commissions, addresses, profiles,
--   couriers, fleets, courier_positions, courier_events, pricing_rules, fx_rates, audit_log, zones. `anon` still has
--   no privilege on any of them, and nothing below grants any.
--
-- COLUMNS: anon gets a COLUMN-level SELECT (an allowlist), not the whole row, so a column added to these tables
-- later (a cost price, an internal note) is NOT public until someone decides it should be. Every current column of
-- the five catalog tables is customer-facing, so each is listed.
--
-- merchants_public columns exposed to the public now: id, name, kind, city, country, address_text, lat, lng, phone,
-- prep_time_min, is_open_manual, accepts_cross_border, logo_url, cover_url. Two deserve a decision by the owner:
-- `phone` (an informal trailer's number may be the owner's personal line) and lat/lng (the shop's location). They
-- were already visible to every signed-in client, and a shop's address and phone are what a storefront shows, so
-- they stay; if a shop should not show its phone, the fix is to null it in `merchants`, not to hide it here.

-- ---------------------------------------------------------------------------------------------
-- merchants_public: approved shops, for a visitor with no session OR a signed-in client.
-- A signed-in user who is not a client (courier, merchant, fleet, admin, or a pending/blocked account) still gets
-- nothing from the view, exactly as before. `auth.uid() is null` is "no session"; service_role also has no uid and
-- already had SELECT on the view.
--
-- WHY A HELPER INSTEAD OF app_role() IN THE VIEW: the view runs its TABLE reads as its owner, but Postgres checks
-- EXECUTE on the functions it calls as the CALLER. anon has no EXECUTE on public.app_role() (0008 revoked it on
-- purpose), so the view failed with "permission denied for function app_role". Rather than hand anon app_role(), a
-- narrow SECURITY DEFINER helper answers the one question the view asks, and lives in `private` (not exposed by
-- PostgREST).
-- ---------------------------------------------------------------------------------------------
grant usage on schema private to anon;

create function private.browsing_allowed() returns boolean
language sql stable security definer set search_path = ''
as $$ select (select auth.uid()) is null or (select public.app_role()) = 'client' $$;
revoke all on function private.browsing_allowed() from public;
grant execute on function private.browsing_allowed() to anon, authenticated, service_role;

create or replace view public.merchants_public with (security_invoker = false, security_barrier = true) as
select m.id, m.name, m.kind, m.city, m.country, m.address_text, m.lat, m.lng, m.phone,
       m.prep_time_min, m.is_open_manual, m.accepts_cross_border, m.logo_url, m.cover_url
from public.merchants m
where m.status = 'approved' and (select private.browsing_allowed());

grant select on public.merchants_public to anon;

-- ---------------------------------------------------------------------------------------------
-- The policies below call private helpers. A policy runs as the CALLING role, so anon needs USAGE on the schema (granted
-- above) and EXECUTE on exactly these three (SECURITY DEFINER boolean/uuid lookups). PostgREST does not expose `private`, so
-- they are not reachable as /rpc endpoints.
-- ---------------------------------------------------------------------------------------------
grant execute on function private.merchant_is_public(uuid), private.item_merchant_id(uuid), private.group_merchant_id(uuid) to anon;

-- ---------------------------------------------------------------------------------------------
-- Menu tables: column allowlist + a policy that only admits rows of an approved shop.
-- ---------------------------------------------------------------------------------------------
grant select (id, merchant_id, name, sort_order) on public.catalog_categories to anon;
grant select (id, merchant_id, category_id, name, description, price_brl, photo_url, is_available, sort_order) on public.catalog_items to anon;
grant select (id, item_id, name, min_select, max_select, is_required) on public.item_option_groups to anon;
grant select (id, group_id, name, price_delta_brl, is_available) on public.item_options to anon;
grant select (id, merchant_id, weekday, opens_at, closes_at) on public.merchant_hours to anon;

create policy catalog_categories_select_anon on public.catalog_categories for select to anon
  using (private.merchant_is_public(merchant_id));
create policy catalog_items_select_anon on public.catalog_items for select to anon
  using (private.merchant_is_public(merchant_id));
create policy item_option_groups_select_anon on public.item_option_groups for select to anon
  using (private.merchant_is_public(private.item_merchant_id(item_id)));
create policy item_options_select_anon on public.item_options for select to anon
  using (private.merchant_is_public(private.group_merchant_id(group_id)));
create policy merchant_hours_select_anon on public.merchant_hours for select to anon
  using (private.merchant_is_public(merchant_id));

-- ---------------------------------------------------------------------------------------------
-- Service window: the same function quote_order uses. SECURITY DEFINER, reads only the public `service_hours`
-- setting, returns a boolean, and raises on a missing configuration (fails closed in the caller).
-- ---------------------------------------------------------------------------------------------
grant execute on function public.is_within_service_hours(text, public.order_kind, timestamptz) to anon;
