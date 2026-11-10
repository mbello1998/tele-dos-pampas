-- Task 5b follow-up (review rulings).
--
-- 1. courier_events.courier_id: ON DELETE CASCADE -> RESTRICT. Under cascade, deleting a courier (or its
--    profile) would erase the fleet owner's whole record of that person's shifts and radius changes, which
--    is the one thing the feed exists to preserve. Like an order, a courier is never deleted: blocking or
--    suspending is a status. With RESTRICT an accidental delete becomes an error.
-- 2. The radius authority is private.effective_radius_km(). The stored preference may sit above the
--    effective cap (e.g. after the global ceiling is lowered), and that is harmless only if dispatch never
--    reads work_radius_km directly. Said on the columns themselves so the next person cannot miss it.

alter table public.courier_events
  drop constraint courier_events_courier_id_fkey,
  add constraint courier_events_courier_id_fkey
    foreign key (courier_id) references public.couriers (profile_id) on delete restrict;

comment on column public.couriers.work_radius_km is
  'The courier''s STORED preference in km (null = no preference). NOT the radius to dispatch with: it can sit above the real cap (global ceiling lowered later). Dispatch and any radius filter MUST call private.effective_radius_km(profile_id) = least(courier, fleet, global) and never read this column directly.';
comment on column public.fleets.max_radius_km is
  'The most the fleet owner allows (null = no fleet-specific cap). Stored value only; the radius in force is private.effective_radius_km(courier).';
comment on function private.effective_radius_km(uuid) is
  'The radius in force for a courier: least(work_radius_km, fleet max_radius_km, settings.service_radius_km); nulls are ignored. The single authority for dispatch.';
