-- City is stored as the street dataset's slug ('quarai' | 'artigas'), never as a display name.
-- Display names belong to the i18n layer.

update public.merchants set city = case city when 'Quaraí' then 'quarai' else lower(city) end where city in ('Quaraí', 'Artigas');
update public.pricing_rules set city = case city when 'Quaraí' then 'quarai' else lower(city) end where city in ('Quaraí', 'Artigas');

alter table public.profiles add constraint profiles_home_city_check check (home_city in ('quarai', 'artigas'));
alter table public.fleets add constraint fleets_city_check check (city in ('quarai', 'artigas'));
alter table public.merchants add constraint merchants_city_check check (city in ('quarai', 'artigas'));
alter table public.couriers add constraint couriers_base_city_check check (base_city in ('quarai', 'artigas'));
alter table public.addresses add constraint addresses_city_check check (city in ('quarai', 'artigas'));
alter table public.zones add constraint zones_city_check check (city in ('quarai', 'artigas'));
alter table public.pricing_rules add constraint pricing_rules_city_check check (city in ('quarai', 'artigas'));

comment on table public.status_transitions is
  'Allowed status moves per kind and role. The admin path is DELIBERATELY not enumerated here: transition_order() checks is_admin() before consulting this table (reason mandatory, always written to order_events). Do not add admin rows.';
