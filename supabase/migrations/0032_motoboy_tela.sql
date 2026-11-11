-- 0032: the courier's screen. Three things the screen cannot do without, none of them reachable before.
--
--   1. my_effective_radius_km(): the courier's own radius in force, for the screen to filter the queue with.
--      private.effective_radius_km() is the authority (least of courier, fleet and global ceiling) but the
--      `private` schema is deliberately not exposed by PostgREST, and the column comment on
--      couriers.work_radius_km forbids reading the stored preference instead. This is the narrow door: it
--      answers only for auth.uid(), takes no argument, and returns null for anyone who is not a courier.
--
--   2. courier_orders.requester_name: who is calling, the first thing the courier needs to know.
--        * a SHOP is named always: a business trading in public, and the first thing the owner said the
--          courier needs to see ("Trailer do Zé");
--        * a PERSON is NOT named to every courier browsing the open queue (that would hand each courier in town
--          a list of who is ordering what, tonight, to which address). The column is NULL until the courier has
--          claimed the order, and is the client's FIRST NAME from then on: they are about to knock on that door.
--      NULL, not a label, because the wording is the screen's job (pt-BR and es-UY), not the database's.
--      Columns are only appended: CREATE OR REPLACE VIEW keeps the grants and the existing column order.
--
--   3. transition_order(): the claim now refuses a courier who declined that kind of job, exactly as
--      assign_courier() already does for the dispatcher. Before this, the flags accepts_cross_border and
--      accepts_passenger were enforced on the admin's path and ignored on the courier's own, so a hand-made
--      request could take a job the courier had declined. 23514, with HINT 'cross_border' or 'passenger'.
--      The rest of the function is the live definition, unchanged.

-- ---------------------------------------------------------------------------------------------
-- 1. my_effective_radius_km
-- ---------------------------------------------------------------------------------------------
create function public.my_effective_radius_km() returns numeric
language sql stable security definer set search_path = ''
as $$
  select private.effective_radius_km((select auth.uid()))
  where (select public.app_role()) = 'courier'
$$;
revoke all on function public.my_effective_radius_km() from public, anon, authenticated, service_role;
grant execute on function public.my_effective_radius_km() to authenticated;
comment on function public.my_effective_radius_km() is
  'The radius in force for the calling courier: private.effective_radius_km(auth.uid()) = least(courier preference, fleet maximum, global ceiling). Null when the caller is not an active courier, or when no layer sets a radius. Filter the queue with this, never with couriers.work_radius_km.';

-- ---------------------------------------------------------------------------------------------
-- 2. courier_orders.requester_name
-- ---------------------------------------------------------------------------------------------
create or replace view public.courier_orders with (security_invoker = false, security_barrier = true) as
select o.id, o.code, o.kind, o.status, o.status_updated_at, o.created_at, o.accepted_at, o.prepared_at,
       o.picked_up_at, o.delivered_at, o.cancelled_at, o.pickup_address, o.dropoff_address,
       o.distance_m, o.crosses_border, o.courier_id, o.fleet_id, o.eta_minutes, o.client_notes,
       o.payment_method,
       case when o.courier_id = (select auth.uid()) then o.currency_charged end as currency_charged,
       (case when o.courier_id = (select auth.uid()) then o.total_charged end)::numeric(10, 2) as total_charged,
       (case when o.courier_id = (select auth.uid()) then o.change_for end)::numeric(10, 2) as change_for,
       private.delivery_fee_brl(o.pricing_breakdown)::numeric(10, 2) as delivery_fee_brl,
       case
         when o.merchant_id is not null
           then (select m.name from public.merchants m where m.id = o.merchant_id)
         when o.courier_id = (select auth.uid())
           then nullif(split_part(btrim(coalesce((select p.full_name from public.profiles p where p.id = o.client_id), '')), ' ', 1), '')
       end as requester_name,
       o.merchant_id is not null as requester_is_shop
from public.orders o
where private.courier_sees_order(o.courier_id, o.kind, o.status, o.pickup_address, o.merchant_id);

-- ---------------------------------------------------------------------------------------------
-- 3. transition_order: the claim honours accepts_cross_border and accepts_passenger
-- ---------------------------------------------------------------------------------------------
create or replace function public.transition_order(p_order uuid, p_to order_status, p_note text DEFAULT NULL::text, p_expected_from order_status DEFAULT NULL::order_status)
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
  v_cross boolean;
  v_passenger boolean;
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
        -- The courier's own boundaries, the same two assign_courier() enforces for the dispatcher. Showing a
        -- job and then ignoring the flags would hand a ride to someone who does not carry passengers, or a
        -- crossing to someone who does not cross the bridge, and the customer would wait for a refusal on arrival.
        -- SQLSTATE 23514 like assign_courier; HINT says which boundary, so the screen can speak plainly.
        select c.fleet_id, c.accepts_cross_border, c.accepts_passenger into v_fleet, v_cross, v_passenger
        from public.couriers c where c.profile_id = v_uid;
        if v_o.crosses_border and not coalesce(v_cross, false) then
          raise exception 'courier does not accept orders that cross the border' using errcode = '23514', hint = 'cross_border';
        end if;
        if v_o.kind = 'ride' and not coalesce(v_passenger, false) then
          raise exception 'courier does not accept passengers' using errcode = '23514', hint = 'passenger';
        end if;
        v_claim := true;
        -- The fleet is copied from the courier (read above): null for an independent courier, whose fee is entirely theirs.
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
