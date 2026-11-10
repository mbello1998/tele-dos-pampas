-- 6.3 Enderecos e geografia

create table public.addresses (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  label text,
  street_id text, -- stable id from the OSM street dataset
  street_name text, -- denormalized for history
  number text,
  complement text,
  between_streets text,
  reference text, -- free text, first-class field
  city text not null,
  country text not null check (country in ('BR', 'UY')),
  lat numeric(9, 6),
  lng numeric(9, 6),
  precision public.address_precision not null default 'rua',
  is_default boolean not null default false
);
create index addresses_profile_idx on public.addresses (profile_id);
create unique index addresses_one_default_idx on public.addresses (profile_id) where is_default;

create table public.zones (
  id uuid primary key default gen_random_uuid(),
  city text not null,
  name text not null,
  polygon jsonb, -- GeoJSON
  surcharge_brl numeric(10, 2) not null default 0 check (surcharge_brl >= 0),
  is_served boolean not null default true,
  notes text
);
create index zones_city_idx on public.zones (city);

alter table public.addresses enable row level security;
alter table public.zones enable row level security;
