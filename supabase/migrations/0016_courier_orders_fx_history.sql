-- Second hardening round.
--   1. courier_orders view: a courier no longer reads `orders` (or `order_items`) directly. Like the fleet,
--      a courier works in the restaurant every day and may work for several parties; orders.total_brl and
--      pricing_breakdown carry the items subtotal and the commission of a food order, and order_items carry
--      unit prices. The view exposes the operational columns, the amount to collect (total_charged,
--      currency_charged, change_for, payment_method) and the delivery-fee portion of the breakdown.
--   2. fx_rates is history: versioned by date and never edited in place. A new rate or a manual override is
--      a NEW row (see the unique key in 0015). No role, admin included, may UPDATE or DELETE a row.

-- ---------------------------------------------------------------------------------------------
-- 1. courier visibility, written once and used by the view and by the order_events policy
-- ---------------------------------------------------------------------------------------------
-- A courier sees an order when they carry it, or when it is in the open queue of the city where they are
-- approved: courier_id null, a status that is waiting for a courier, same pickup city.
create function private.courier_sees_order(
  p_courier uuid, p_kind public.order_kind, p_status public.order_status, p_pickup jsonb, p_merchant uuid
) returns boolean
language sql stable security definer set search_path = ''
as $$
  select (select private.courier_base_city()) is not null
    and (
      p_courier = (select auth.uid())
      or (
        p_courier is null
        and (
          (p_kind = 'courier' and p_status = 'aguardando_motoboy')
          or (p_kind = 'ride' and p_status = 'criado')
          or (p_kind = 'food' and p_status = 'pronto')
        )
        and private.order_city(p_pickup, p_merchant) = (select private.courier_base_city())
      )
    )
$$;

create function private.courier_sees_order_id(p_order uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.orders o
    where o.id = p_order and private.courier_sees_order(o.courier_id, o.kind, o.status, o.pickup_address, o.merchant_id)
  )
$$;

revoke all on function private.courier_sees_order(uuid, public.order_kind, public.order_status, jsonb, uuid),
  private.courier_sees_order_id(uuid) from public;
grant execute on function private.courier_sees_order(uuid, public.order_kind, public.order_status, jsonb, uuid),
  private.courier_sees_order_id(uuid) to authenticated, service_role;

-- Same pattern as fleet_orders (owner-privileges view, security barrier, read-only). The amounts to
-- collect are shown only on orders the courier ALREADY carries; an order still in the queue shows its
-- payment method and delivery fee but not the totals. Never exposed: total_brl, pricing_breakdown,
-- fx_*, client_id, merchant_id.
-- Honest limit: for a cash order the courier necessarily learns total_charged, so items + commission
-- (total minus delivery fee) is arithmetically implied; the commission alone is not derivable and the
-- breakdown and item lines are unreachable.
create view public.courier_orders with (security_invoker = false, security_barrier = true) as
select o.id, o.code, o.kind, o.status, o.status_updated_at, o.created_at, o.accepted_at, o.prepared_at,
       o.picked_up_at, o.delivered_at, o.cancelled_at, o.pickup_address, o.dropoff_address,
       o.distance_m, o.crosses_border, o.courier_id, o.fleet_id, o.eta_minutes, o.client_notes,
       o.payment_method,
       case when o.courier_id = (select auth.uid()) then o.currency_charged end as currency_charged,
       (case when o.courier_id = (select auth.uid()) then o.total_charged end)::numeric(10, 2) as total_charged,
       (case when o.courier_id = (select auth.uid()) then o.change_for end)::numeric(10, 2) as change_for,
       private.delivery_fee_brl(o.pricing_breakdown)::numeric(10, 2) as delivery_fee_brl
from public.orders o
where private.courier_sees_order(o.courier_id, o.kind, o.status, o.pickup_address, o.merchant_id);

revoke all on public.courier_orders from public, anon, authenticated, service_role;
grant select on public.courier_orders to authenticated, service_role;

-- The courier's direct reads of orders and order_items are gone (prices live there).
drop policy orders_select_courier on public.orders;
drop policy order_items_select_courier on public.order_items;

-- The timeline carries no money: the courier keeps reading events of the orders it can see.
create policy order_events_select_courier on public.order_events for select to authenticated
  using (private.courier_sees_order_id(order_id));

-- ---------------------------------------------------------------------------------------------
-- 2. fx_rates is append-only for every API role
-- ---------------------------------------------------------------------------------------------
drop policy if exists fx_rates_update_admin on public.fx_rates;
drop policy if exists fx_rates_delete_admin on public.fx_rates;
-- second wall: no UPDATE/DELETE privilege either (service_role bypasses RLS by design and is server-side only)
revoke update, delete on public.fx_rates from authenticated;

-- courier_positions insert checked "the order is mine" with a sub-select on orders under the courier's own
-- RLS, which no longer lets a courier see orders. A definer helper answers the same question.
create function private.courier_carries_order(p_order uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.orders o where o.id = p_order and o.courier_id = (select auth.uid()))
$$;
revoke all on function private.courier_carries_order(uuid) from public;
grant execute on function private.courier_carries_order(uuid) to authenticated, service_role;

drop policy courier_positions_insert_own on public.courier_positions;
create policy courier_positions_insert_own on public.courier_positions for insert to authenticated
  with check (
    courier_id = (select auth.uid())
    and (select private.courier_base_city()) is not null
    and (order_id is null or private.courier_carries_order(order_id))
  );
