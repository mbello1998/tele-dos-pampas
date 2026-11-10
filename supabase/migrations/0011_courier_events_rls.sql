-- Task 5b: courier_events, the operational feed the fleet owner reads.
--
-- Who changed their radius, who went online, who went offline. Written ONLY by a trigger on couriers,
-- never by application code, so no code path can change a courier's radius or shift without a trace.
--
-- It is deliberately a separate table from audit_log. audit_log is a security artifact readable only by
-- admin; widening its RLS to fleet owners would open a leak path onto every audited table. The operational
-- toggles (is_online, is_available) are excluded from the couriers audit trigger (0014) precisely because
-- they belong here. Do not add them back to the audit.
--
-- fleet_id is COPIED at event time (not joined later), so the history stays attached to the fleet the
-- courier belonged to when it happened, and survives the courier moving to another fleet: the old owner
-- keeps seeing the old stretch, the new owner sees only what happens on their watch.

create table public.courier_events (
  id bigint generated always as identity primary key,
  courier_id uuid not null references public.couriers (profile_id) on delete cascade,
  fleet_id uuid references public.fleets (id), -- null for an independent courier
  kind text not null check (kind in (
    'radius_changed', 'went_online', 'went_offline', 'became_available', 'became_busy', 'capped_by_fleet'
  )),
  from_value text,
  to_value text,
  actor_id uuid, -- auth.uid() of whoever made the change; null for a server-side change
  created_at timestamptz not null default now()
);
create index courier_events_courier_idx on public.courier_events (courier_id, created_at desc);
create index courier_events_fleet_idx on public.courier_events (fleet_id, created_at desc);

alter table public.courier_events enable row level security;

-- Append-only for every API role: SELECT is the only privilege and the only kind of policy. There is
-- no INSERT, UPDATE, DELETE or TRUNCATE privilege for anyone (admin included) and no write policy either,
-- so a privilege granted by mistake would still meet RLS. Rows enter through the trigger below, which runs
-- as the table owner.
revoke all on public.courier_events from anon, authenticated, service_role;
grant select on public.courier_events to authenticated, service_role;

create policy courier_events_select_admin on public.courier_events for select to authenticated
  using ((select public.is_admin()));

-- The owner of an approved fleet reads the events recorded under that fleet.
create policy courier_events_select_fleet on public.courier_events for select to authenticated
  using (fleet_id in (select private.owned_fleet_ids()));

-- A courier reads their own (and, like every courier policy, only while their profile is active).
create policy courier_events_select_own on public.courier_events for select to authenticated
  using ((select public.app_role()) = 'courier' and courier_id = (select auth.uid()));
-- client, merchant, anon and pending/blocked profiles: no policy, so no rows.

-- ---------------------------------------------------------------------------------------------
-- The writer. AFTER ROW, so a change refused by a BEFORE guard (radius above the ceiling, a column the
-- role may not write) leaves no event. One event per changed field; an update that changes none of the
-- watched fields writes nothing. A new courier is compared against the column defaults (offline, free, no
-- radius), so being born online or with a radius also leaves a trace.
-- ---------------------------------------------------------------------------------------------
create function private.courier_events_write() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  o_online boolean := false;
  o_available boolean := true;
  o_radius numeric := null;
  -- set by fleet_cap_couriers() (0010). The trigger depth makes the label unforgeable: a direct UPDATE by
  -- a session runs this trigger at depth 1, the fleet's cap runs it nested at depth 2.
  v_capped boolean := coalesce(current_setting('app.courier_cap_reason', true), '') = 'fleet' and pg_trigger_depth() > 1;
begin
  if tg_op = 'UPDATE' then
    o_online := old.is_online;
    o_available := old.is_available;
    o_radius := old.work_radius_km;
  end if;

  if new.is_online is distinct from o_online then
    insert into public.courier_events (courier_id, fleet_id, kind, from_value, to_value, actor_id)
    values (new.profile_id, new.fleet_id, case when new.is_online then 'went_online' else 'went_offline' end,
            o_online::text, new.is_online::text, v_actor);
  end if;

  if new.is_available is distinct from o_available then
    insert into public.courier_events (courier_id, fleet_id, kind, from_value, to_value, actor_id)
    values (new.profile_id, new.fleet_id, case when new.is_available then 'became_available' else 'became_busy' end,
            o_available::text, new.is_available::text, v_actor);
  end if;

  if new.work_radius_km is distinct from o_radius then
    insert into public.courier_events (courier_id, fleet_id, kind, from_value, to_value, actor_id)
    values (new.profile_id, new.fleet_id, case when v_capped then 'capped_by_fleet' else 'radius_changed' end,
            o_radius::text, new.work_radius_km::text, v_actor);
  end if;
  return null;
end
$$;
revoke all on function private.courier_events_write() from public, anon, authenticated;

create trigger courier_events_write after insert or update on public.couriers
  for each row execute function private.courier_events_write();
