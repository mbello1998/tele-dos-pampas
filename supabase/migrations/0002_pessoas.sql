-- 6.1 Pessoas e negocios

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role public.user_role not null default 'client',
  full_name text,
  phone text, -- kept and nullable: auth starts as email OTP
  locale text not null default 'pt-BR' check (locale in ('pt-BR', 'es-UY')),
  currency_pref text not null default 'BRL' check (currency_pref in ('BRL', 'UYU')),
  home_city text,
  country text check (country in ('BR', 'UY')),
  status text not null default 'active' check (status in ('active', 'pending', 'blocked')),
  created_at timestamptz not null default now()
);

create table public.fleets (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id),
  name text not null,
  city text not null,
  phone text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'suspended'))
);

create table public.merchants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles (id), -- nullable: example/unclaimed merchants have no owner yet
  name text not null,
  kind public.merchant_kind not null,
  city text not null,
  country text not null check (country in ('BR', 'UY')),
  address_text text,
  lat numeric(9, 6),
  lng numeric(9, 6),
  phone text,
  prep_time_min integer not null default 20 check (prep_time_min >= 0),
  commission_pct numeric(5, 2) not null default 0 check (commission_pct between 0 and 100),
  is_open_manual boolean not null default true,
  accepts_cross_border boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'approved', 'suspended')),
  logo_url text,
  cover_url text
);
create index merchants_owner_idx on public.merchants (owner_id);
create index merchants_city_idx on public.merchants (city, status);

create table public.merchant_hours (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  opens_at time not null,
  closes_at time not null
);
create index merchant_hours_merchant_idx on public.merchant_hours (merchant_id, weekday);

create table public.couriers (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  vehicle text not null check (vehicle in ('moto', 'bike', 'carro')),
  plate text,
  base_city text not null,
  accepts_cross_border boolean not null default false,
  accepts_passenger boolean not null default false,
  is_online boolean not null default false,
  rating_avg numeric(3, 2),
  fleet_id uuid references public.fleets (id), -- null for independent couriers
  status text not null default 'pending' check (status in ('pending', 'approved', 'suspended'))
);
create index couriers_fleet_idx on public.couriers (fleet_id);

alter table public.profiles enable row level security;
alter table public.fleets enable row level security;
alter table public.merchants enable row level security;
alter table public.merchant_hours enable row level security;
alter table public.couriers enable row level security;
