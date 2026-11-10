-- Task 13: the order state machine (transition_order) and the admin's manual dispatch (assign_courier,
-- dispatch_couriers).
--
-- WHO MOVES AN ORDER. Nobody moves a row of `orders` directly. The client, the merchant and the courier call
-- transition_order(); the admin calls transition_order() or assign_courier(). All of them are SECURITY DEFINER:
-- they run as the table owner with search_path pinned, and every reference is schema-qualified, so a caller
-- cannot redirect what they touch. orders_move_guard (below) refuses a direct UPDATE of status, courier_id or
-- fleet_id from any API role, ADMIN INCLUDED, so that no path can change the state of an order without the
-- event that records who did it.
--
-- THE ADMIN BYPASS LIVES IN THE FUNCTION, NOT IN THE TABLE. status_transitions deliberately has no admin
-- rows: enumerating every status pair for the admin would be roughly forty rows duplicating the table, and
-- would still not express "any status to any status". transition_order() checks the caller's role BEFORE it
-- consults the table; an admin transition needs a mandatory reason and is always written to order_events.
-- Do not "fix" this by adding admin rows (see the comment on status_transitions in 0007).
--
-- Three rules the admin does NOT bypass, because each one keeps the record honest:
--   * a reason (always),
--   * the target status must belong to the order's own flow (a ride never becomes em_rota),
--   * an order cannot enter a status that implies a courier (aceito, coletado, entregue...) without a courier:
--     assign one first. Otherwise a delivered order could carry no record of who delivered it.
--
-- THE ACCEPT IS ATOMIC. The order row is locked with SELECT ... FOR UPDATE before anything is validated, so two
-- couriers accepting the same order are serialised: the second wakes up, re-reads the committed row, finds it
-- already has a courier, and is refused. An order ends with exactly one courier under any interleaving.
--
-- DEADLOCKS. Callers that touch couriers or fleets must retry once on 40P01 (see the comments on
-- courier_radius_guard and fleet_cap_couriers in 0010). The Server Actions of the console do.

-- ---------------------------------------------------------------------------------------------
-- Guard: only the functions below move an order.
-- ---------------------------------------------------------------------------------------------
-- Not SECURITY DEFINER on purpose: current_user must be the CALLER's database role. Inside transition_order()
-- it is the owner, so the function passes; PostgREST sessions run as anon/authenticated and do not. The check
-- reads current_user, which a session cannot forge (unlike a setting it could set_config itself).
create function private.orders_move_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and (new.status is distinct from old.status
          or new.courier_id is distinct from old.courier_id
          or new.fleet_id is distinct from old.fleet_id) then
    raise exception 'an order moves only through transition_order() or assign_courier()' using errcode = '42501';
  end if;
  return new;
end
$$;
revoke all on function private.orders_move_guard() from public;

create trigger orders_move_guard before update on public.orders
  for each row execute function private.orders_move_guard();

-- ---------------------------------------------------------------------------------------------
-- transition_order
-- ---------------------------------------------------------------------------------------------
create function public.transition_order(p_order uuid, p_to public.order_status, p_note text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
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
        -- Only the open queue can be claimed: courier/aguardando_motoboy, ride/criado, food/pronto.
        if not ((v_o.kind = 'courier' and v_o.status = 'aguardando_motoboy')
                or (v_o.kind = 'ride' and v_o.status = 'criado')
                or (v_o.kind = 'food' and v_o.status = 'pronto')) then
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
$$;

-- ---------------------------------------------------------------------------------------------
-- assign_courier: the dispatcher hands an order to a courier (phone, radio), admin only.
-- ---------------------------------------------------------------------------------------------
-- It does what the courier's own accept does, on the courier's behalf, and it may also REASSIGN. For a courier
-- or ride order sitting in the queue it also moves the order to 'aceito'; in any other state the status is
-- left alone (a food order is accepted at 'coletado' by the courier it was handed to, and an order already
-- accepted keeps its status when the courier changes). fleet_id is copied from the courier and is set to NULL
-- for an independent one, replacing a stale value rather than keeping it: the delivery fee must follow the
-- courier who actually drives. The event names the courier, so a later reassignment does not erase who had it.
create function public.assign_courier(p_order uuid, p_courier uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_note text := nullif(btrim(coalesce(p_note, ''), E' \t\r\n'), '');
  v_o public.orders%rowtype;
  v_fleet uuid;
  v_to public.order_status;
begin
  if not (select public.is_admin()) then
    raise exception 'only an administrator assigns couriers' using errcode = '42501';
  end if;
  if v_note is null then
    raise exception 'assigning a courier requires a reason' using errcode = '22023';
  end if;

  select * into v_o from public.orders o where o.id = p_order for update;
  if not found then
    raise exception 'order % not found', p_order using errcode = 'P0002';
  end if;
  if v_o.status in ('entregue', 'finalizado', 'cancelado') then
    raise exception 'order is closed (status %)', v_o.status using errcode = '55000';
  end if;

  select c.fleet_id into v_fleet
  from public.couriers c join public.profiles p on p.id = c.profile_id
  where c.profile_id = p_courier and c.status = 'approved' and p.status = 'active' and p.role = 'courier';
  if not found then
    raise exception 'courier % not found or not approved', p_courier using errcode = 'P0002';
  end if;

  v_to := case
    when (v_o.kind = 'courier' and v_o.status = 'aguardando_motoboy') or (v_o.kind = 'ride' and v_o.status = 'criado')
      then 'aceito'::public.order_status
    else v_o.status end;

  update public.orders o set
    courier_id = p_courier,
    fleet_id = v_fleet,
    status = v_to,
    status_updated_at = case when v_to is distinct from o.status then now() else o.status_updated_at end,
    accepted_at = case when v_to = 'aceito' then coalesce(o.accepted_at, now()) else o.accepted_at end
  where o.id = v_o.id;

  insert into public.order_events (order_id, from_status, to_status, actor_id, actor_role, note)
  values (v_o.id, v_o.status, v_to, v_uid, 'admin', 'courier ' || p_courier::text || ' assigned: ' || v_note);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- dispatch_couriers: who the dispatcher can hand an order to, with the radius that actually applies.
-- ---------------------------------------------------------------------------------------------
-- The radius is private.effective_radius_km() (the least of the global ceiling, the fleet maximum and the
-- courier's own choice). Dispatch NEVER reads couriers.work_radius_km directly: it is only one of three layers.
create function public.dispatch_couriers(p_city text default null)
returns table (
  profile_id uuid, full_name text, vehicle text, base_city text, is_online boolean, is_available boolean,
  accepts_cross_border boolean, accepts_passenger boolean, fleet_id uuid, fleet_name text, effective_radius_km numeric
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (select public.is_admin()) then
    raise exception 'only an administrator lists couriers for dispatch' using errcode = '42501';
  end if;
  return query
  select c.profile_id, p.full_name, c.vehicle, c.base_city, c.is_online, c.is_available,
         c.accepts_cross_border, c.accepts_passenger, c.fleet_id, f.name,
         private.effective_radius_km(c.profile_id)
  from public.couriers c
  join public.profiles p on p.id = c.profile_id
  left join public.fleets f on f.id = c.fleet_id
  where c.status = 'approved' and p.status = 'active' and (p_city is null or c.base_city = p_city)
  order by c.is_online desc, p.full_name;
end
$$;

-- Supabase's default privileges hand new functions to anon/authenticated/service_role: close it all, then open
-- exactly what is meant. The functions refuse an anonymous caller anyway (no active profile), this is the
-- second lock.
revoke all on function
  public.transition_order(uuid, public.order_status, text),
  public.assign_courier(uuid, uuid, text),
  public.dispatch_couriers(text)
from public, anon, authenticated, service_role;
grant execute on function
  public.transition_order(uuid, public.order_status, text),
  public.assign_courier(uuid, uuid, text),
  public.dispatch_couriers(text)
to authenticated;

comment on function public.transition_order(uuid, public.order_status, text) is
  'The only way an order changes status. SECURITY DEFINER. Locks the row (FOR UPDATE) before validating, so the accept is atomic. Non-admin: validated against status_transitions for the caller''s role. Admin: any status of the order''s own flow, mandatory reason, always recorded; the bypass is here on purpose and status_transitions has no admin rows.';
