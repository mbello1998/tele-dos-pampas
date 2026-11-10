-- Task 5b review fixes.
--
-- 1. is_within_service_hours FAILS CLOSED on a malformed window. Before this, a window missing `opens` or
--    `closes` (an admin saves {"quarai":{"food":{}}}) left v_opens/v_closes null, fell through to the final
--    ELSE and returned NULL; a caller written as `if not is_within_service_hours(...)` treats NULL as
--    "not false" and would have ACCEPTED an order at 1 a.m., which the municipal rule forbids. A time
--    restriction that is the law must never fail open: every malformed shape now raises, naming
--    service_hours, the city and the kind. (A null instant already raised; a bad timezone raises from
--    `at time zone`.)
--    An UNKNOWN kind still raises, but with 22P02 from the enum cast (invalid input value for enum
--    order_kind) rather than a service_hours message. Left as is on purpose: it also fails closed.
-- 2. The two radius triggers can deadlock against each other (documented in comments below).

create or replace function public.is_within_service_hours(
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

  begin
    v_opens := (v_win ->> 'opens')::time;
    v_closes := (v_win ->> 'closes')::time;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    raise exception 'service_hours has an unreadable time for city %, kind % (window: %)', p_city, p_kind, v_win
      using errcode = '55000';
  end;
  if v_opens is null or v_closes is null then
    raise exception 'service_hours window for city %, kind % needs both "opens" and "closes" (window: %)', p_city, p_kind, v_win
      using errcode = '55000';
  end if;

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

comment on function public.is_within_service_hours(text, public.order_kind, timestamptz) is
  'True when the service window of (city, kind) is open at the instant, on the CITY''s wall clock. Never returns NULL: a missing city/kind/timezone, a window without opens or closes, an unreadable time, or a null instant RAISES (fail closed, because this is a legal restriction and `if not NULL` would let the caller proceed). An unknown kind raises 22P02 from the enum cast, not a service_hours message; it also fails closed. opens = closes means 24 hours; closes <= opens crosses midnight; start inclusive, end exclusive.';

comment on trigger courier_radius_guard on public.couriers is
  'Rejects a radius above the fleet maximum or the global ceiling. DEADLOCK RISK with fleet_cap_couriers: Postgres locks the courier row BEFORE this trigger runs, then this trigger takes the fleet row FOR SHARE; a fleet owner lowering max_radius_km locks the fleet row and then updates the courier row. A concurrent courier radius change and owner cap-down can deadlock and one side gets 40P01 (after ~1s). The invariant (no courier above the fleet max) survives; callers, notably the owner''s cap-down, MUST retry on 40P01.';

comment on trigger fleet_cap_couriers on public.fleets is
  'Lowers couriers above the new fleet maximum, same statement. DEADLOCK RISK with courier_radius_guard (see its comment): a concurrent courier radius change can make this statement fail with 40P01; the owner''s write must be retried on 40P01. The invariant is never violated, only the cap-down may need a second attempt.';
