-- Task 5b: service hours per city and the three-layer work radius.
--
-- 1. THE BRIDGE HAS NO HOURS. It is open 24 hours. The only time limit is a municipal rule about the
--    SERVICE (deliveries, errands and rides run 06:00-00:00, every day). The placeholder key
--    settings['bridge_hours'] (06:00-22:00) modelled the wrong thing and would have closed the app at
--    22:00, so it is DELETED here, not merely ignored. Nothing about crossing the border may ever be
--    refused for the time of day; a cross-border order at 02:00 is refused only if the service itself is
--    closed at 02:00, exactly like a same-city one.
-- 2. settings['service_hours'] is structured per city and per order kind because the two cities are
--    municipalities of two countries and may diverge. Shape:
--      { "<city>": { "timezone": "<IANA zone>", "<kind>": { "opens": "HH:MM", "closes": "HH:MM" }, ... } }
--    A window whose closes <= opens crosses midnight (06:00 -> 00:00 is "open from 06:00 until midnight").
--    opens = closes means open 24 hours. The end is exclusive, the start inclusive. `opens` is the admin's
--    to edit (settings is admin-writable); `closes` starts at 00:00 as the municipality requires.
-- 3. The work radius, widest to narrowest:
--      settings['service_radius_km']   product-wide ceiling, admin only (now 5, was 3)
--      fleets.max_radius_km            the most a fleet owner allows (null = no fleet-specific cap)
--      couriers.work_radius_km         the courier's own choice (null = no preference: work up to the ceiling)
--    Writes are validated by triggers, so no path (courier, owner, admin) can store a value above the
--    ceiling above it. Lowering the fleet maximum adjusts the couriers above the new ceiling in the same
--    statement; each adjustment emits a capped_by_fleet event (see 0011).
--    Deliberately NOT done: lowering the GLOBAL ceiling does not rewrite fleets and couriers. Whoever
--    dispatches must use private.effective_radius_km(), which is least(courier, fleet, global).

-- ---------------------------------------------------------------------------------------------
-- settings
-- ---------------------------------------------------------------------------------------------
delete from public.settings where key = 'bridge_hours';

-- Quaraí spans roughly 7 km including rural roads; 3 km would block legitimate addresses. Whether an
-- address is served is decided by the `zones` table; the radius is only a coarse ceiling.
insert into public.settings (key, value, is_public) values ('service_radius_km', '5', true)
on conflict (key) do update set value = excluded.value, updated_at = now();

insert into public.settings (key, value, is_public) values (
  'service_hours',
  '{
    "quarai":  {"timezone": "America/Sao_Paulo",
                "food":    {"opens": "06:00", "closes": "00:00"},
                "courier": {"opens": "06:00", "closes": "00:00"},
                "ride":    {"opens": "06:00", "closes": "00:00"}},
    "artigas": {"timezone": "America/Montevideo",
                "food":    {"opens": "06:00", "closes": "00:00"},
                "courier": {"opens": "06:00", "closes": "00:00"},
                "ride":    {"opens": "06:00", "closes": "00:00"}}
  }'::jsonb,
  true
)
on conflict (key) do update set value = excluded.value, updated_at = now();

-- ---------------------------------------------------------------------------------------------
-- is_within_service_hours(city, kind, at): consumed by order creation (6b) and dispatch (11).
-- The wall clock is the CITY's, not the server's (UTC). A city/kind with no configuration is an ERROR:
-- answering "closed" would hide a broken setting behind a plausible message, and answering "open"
-- would break the rule. A null instant is an error too, because `if not null` is false in plpgsql and
-- would let the caller treat "unknown" as "open".
-- ---------------------------------------------------------------------------------------------
create function public.is_within_service_hours(
  p_city text, p_kind public.order_kind, p_at timestamptz default now()
) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_city jsonb;
  v_win jsonb;
  v_tz text;
  v_opens time;
  v_closes time;
  v_now time;
begin
  if p_at is null then
    raise exception 'is_within_service_hours: the instant must not be null' using errcode = '22004';
  end if;
  select s.value -> p_city into v_city from public.settings s where s.key = 'service_hours';
  v_win := v_city -> (p_kind::text);
  v_tz := v_city ->> 'timezone';
  if v_win is null or jsonb_typeof(v_win) <> 'object' or v_tz is null then
    raise exception 'service_hours has no entry (window and timezone) for city %, kind %', p_city, p_kind
      using errcode = '55000';
  end if;
  v_opens := (v_win ->> 'opens')::time;
  v_closes := (v_win ->> 'closes')::time;
  v_now := (p_at at time zone v_tz)::time;

  if v_opens = v_closes then
    return true; -- 24 hours
  elsif v_opens < v_closes then
    return v_now >= v_opens and v_now < v_closes;
  else
    return v_now >= v_opens or v_now < v_closes; -- crosses midnight
  end if;
end
$$;
revoke all on function public.is_within_service_hours(text, public.order_kind, timestamptz) from public, anon;
grant execute on function public.is_within_service_hours(text, public.order_kind, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- radius columns
-- ---------------------------------------------------------------------------------------------
alter table public.fleets
  add column max_radius_km numeric(5, 2) check (max_radius_km > 0);

alter table public.couriers
  add column work_radius_km numeric(5, 2) check (work_radius_km > 0),
  -- is_available is "free to take an order"; is_online is "on shift". A new courier is free.
  add column is_available boolean not null default true;

-- The global ceiling. Missing or malformed is an error: failing open would let any radius through.
create function private.global_radius_km() returns numeric
language plpgsql stable security definer set search_path = ''
as $$
declare
  v jsonb;
begin
  select s.value into v from public.settings s where s.key = 'service_radius_km';
  if v is null or jsonb_typeof(v) <> 'number' then
    raise exception 'settings.service_radius_km is missing or not a number' using errcode = '55000';
  end if;
  return (v #>> '{}')::numeric;
end
$$;

-- What dispatch should use: the narrowest of the three layers (least() ignores nulls).
create function private.effective_radius_km(p_courier uuid) returns numeric
language sql stable security definer set search_path = ''
as $$
  select least(c.work_radius_km, f.max_radius_km, private.global_radius_km())
  from public.couriers c left join public.fleets f on f.id = c.fleet_id
  where c.profile_id = p_courier
$$;

-- A fleet's maximum may not exceed the global ceiling.
create function private.fleet_radius_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.max_radius_km is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.max_radius_km is not distinct from old.max_radius_km then
    return new;
  end if;
  if new.max_radius_km > private.global_radius_km() then
    raise exception 'fleet max radius % km is above the global ceiling of % km', new.max_radius_km, private.global_radius_km()
      using errcode = '23514'; -- check_violation
  end if;
  return new;
end
$$;

-- A courier's radius may not exceed the fleet's maximum (nor the global ceiling). It is checked when
-- the radius or the fleet changes, so an unrelated update (going online) is never refused because of an
-- old radius. The fleet row is read FOR SHARE: a concurrent owner lowering the maximum holds a row lock,
-- so this waits for that commit and then validates against the NEW maximum instead of the stale one.
create function private.courier_radius_guard() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_fleet_max numeric;
begin
  if new.work_radius_km is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.work_radius_km is not distinct from old.work_radius_km
     and new.fleet_id is not distinct from old.fleet_id then
    return new;
  end if;
  if new.work_radius_km > private.global_radius_km() then
    raise exception 'courier work radius % km is above the global ceiling of % km', new.work_radius_km, private.global_radius_km()
      using errcode = '23514';
  end if;
  if new.fleet_id is not null then
    select f.max_radius_km into v_fleet_max from public.fleets f where f.id = new.fleet_id for share;
    if v_fleet_max is not null and new.work_radius_km > v_fleet_max then
      raise exception 'courier work radius % km is above the fleet maximum of % km', new.work_radius_km, v_fleet_max
        using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;

-- When the owner lowers (or first sets) the fleet maximum, every courier above it comes down to it, in the
-- same statement. SECURITY DEFINER so the adjustment never depends on the caller's own column rights. The
-- local GUC tells the events trigger (0011) that these rows were adjusted by the fleet, not chosen by the
-- courier; the events trigger also requires pg_trigger_depth() > 1, so a session cannot forge the label by
-- setting the GUC itself.
create function private.fleet_cap_couriers() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform set_config('app.courier_cap_reason', 'fleet', true);
  update public.couriers c set work_radius_km = new.max_radius_km
  where c.fleet_id = new.id and c.work_radius_km > new.max_radius_km;
  perform set_config('app.courier_cap_reason', '', true);
  return null;
end
$$;

revoke all on function
  private.global_radius_km(), private.effective_radius_km(uuid), private.fleet_radius_guard(),
  private.courier_radius_guard(), private.fleet_cap_couriers()
from public;
grant execute on function private.global_radius_km(), private.effective_radius_km(uuid) to authenticated, service_role;

create trigger fleet_radius_guard before insert or update on public.fleets
  for each row execute function private.fleet_radius_guard();

create trigger courier_radius_guard before insert or update on public.couriers
  for each row execute function private.courier_radius_guard();

create trigger fleet_cap_couriers after update of max_radius_km on public.fleets
  for each row
  when (new.max_radius_km is not null and new.max_radius_km is distinct from old.max_radius_km)
  execute function private.fleet_cap_couriers();

-- ---------------------------------------------------------------------------------------------
-- Column allowlists. restrict_update_columns freezes every column that is not listed, so without this
-- the new fields would be read-only for the API roles. Same lists as 0009 plus the new columns.
-- ---------------------------------------------------------------------------------------------
drop trigger restrict_update_columns on public.couriers;
create trigger restrict_update_columns before update on public.couriers
  for each row execute function private.restrict_update_columns(
    'vehicle', 'plate', 'accepts_cross_border', 'accepts_passenger', 'is_online', 'is_available', 'work_radius_km');

drop trigger restrict_update_columns on public.fleets;
create trigger restrict_update_columns before update on public.fleets
  for each row execute function private.restrict_update_columns('name', 'phone', 'max_radius_km');
