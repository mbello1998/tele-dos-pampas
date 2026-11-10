-- 6.5 Preco, cambio e configuracao.
-- pricing_rules and fx_rates are versioned by date and never edited in place.

create table public.pricing_rules (
  id uuid primary key default gen_random_uuid(),
  city text not null,
  kind public.order_kind not null,
  base_fare_brl numeric(10, 2) not null check (base_fare_brl >= 0),
  included_km numeric(5, 2) not null check (included_km >= 0),
  per_km_brl numeric(10, 2) not null check (per_km_brl >= 0),
  min_fare_brl numeric(10, 2) not null check (min_fare_brl >= 0),
  night_surcharge_brl numeric(10, 2) not null default 0 check (night_surcharge_brl >= 0),
  night_from time not null default '23:00',
  night_to time not null default '05:00',
  cross_border_fee_brl numeric(10, 2) not null default 0 check (cross_border_fee_brl >= 0),
  passenger_cross_border_fee_brl numeric(10, 2) not null default 0 check (passenger_cross_border_fee_brl >= 0),
  service_fee_pct numeric(5, 2) not null default 0 check (service_fee_pct between 0 and 100),
  valid_from date not null default current_date,
  valid_to date, -- exclusive; null = open-ended
  created_by uuid references public.profiles (id),
  check (valid_to is null or valid_to > valid_from),
  -- two versions can never be valid at once for the same (city, kind)
  constraint pricing_rules_no_overlap exclude using gist (
    city with =,
    kind with =,
    daterange(valid_from, valid_to) with &&
  )
);

create table public.fx_rates (
  id uuid primary key default gen_random_uuid(),
  pair text not null default 'BRL/UYU' check (pair = 'BRL/UYU'),
  rate numeric(12, 6) not null check (rate > 0),
  source text not null check (source in ('fxfeed', 'manual')),
  spread_pct numeric(5, 2) not null default 0 check (spread_pct >= 0),
  is_manual_override boolean not null default false,
  fetched_at timestamptz not null default now(),
  valid_for_date date not null default current_date
);
create index fx_rates_pair_date_idx on public.fx_rates (pair, valid_for_date desc, fetched_at desc);

create table public.settings (
  key text primary key,
  value jsonb not null,
  is_public boolean not null default false,
  updated_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_role public.user_role,
  table_name text not null,
  record_id text,
  action text not null,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_table_idx on public.audit_log (table_name, created_at desc);

create table public.status_transitions (
  kind public.order_kind not null,
  from_status public.order_status not null,
  to_status public.order_status not null,
  allowed_role public.user_role not null,
  primary key (kind, from_status, to_status, allowed_role)
);

alter table public.pricing_rules enable row level security;
alter table public.fx_rates enable row level security;
alter table public.settings enable row level security;
alter table public.audit_log enable row level security;
alter table public.status_transitions enable row level security;

-- Frozen-money references from orders (orders is created in 0005, before these tables exist).
alter table public.orders
  add constraint orders_pricing_rule_fk foreign key (pricing_rule_id) references public.pricing_rules (id),
  add constraint orders_fx_rate_fk foreign key (fx_rate_id) references public.fx_rates (id);
