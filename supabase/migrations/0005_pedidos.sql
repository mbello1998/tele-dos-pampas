-- 6.4 Pedido

-- Short, speakable, unambiguous code (no 0/O/1/I). Uniqueness is enforced by the index below.
create function public.gen_order_code() returns text
language sql volatile
as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '')
  from generate_series(1, 6)
$$;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default public.gen_order_code(),
  kind public.order_kind not null,

  client_id uuid not null references public.profiles (id),
  merchant_id uuid references public.merchants (id), -- null for courier and ride
  courier_id uuid references public.couriers (profile_id), -- null until accepted
  fleet_id uuid references public.fleets (id), -- copied at accept time; null for independent couriers

  pickup_address jsonb not null,
  dropoff_address jsonb not null,
  distance_m integer check (distance_m >= 0),
  route_source public.route_source,
  crosses_border boolean not null default false,

  status public.order_status not null default 'criado',
  status_updated_at timestamptz not null default now(),

  pricing_rule_id uuid, -- FK added in 0006 (pricing_rules is created there)
  pricing_breakdown jsonb,
  total_brl numeric(10, 2) not null check (total_brl >= 0),
  fx_rate_id uuid, -- FK added in 0006
  fx_rate_used numeric(12, 6),
  currency_charged text not null default 'BRL' check (currency_charged in ('BRL', 'UYU')),
  total_charged numeric(10, 2) not null check (total_charged >= 0),
  payment_method public.payment_method not null,
  change_for numeric(10, 2) check (change_for >= 0),

  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  prepared_at timestamptz,
  picked_up_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  cancelled_by uuid references public.profiles (id),

  client_notes text,
  eta_minutes integer check (eta_minutes >= 0),
  rating smallint check (rating between 1 and 5),
  rating_comment text
);
create index orders_client_idx on public.orders (client_id, created_at desc);
create index orders_merchant_idx on public.orders (merchant_id, created_at desc);
create index orders_courier_idx on public.orders (courier_id, created_at desc);
create index orders_fleet_idx on public.orders (fleet_id);
create index orders_status_idx on public.orders (status, kind);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  item_id uuid references public.catalog_items (id) on delete set null, -- historical reference only
  name_snapshot text not null,
  unit_price_brl_snapshot numeric(10, 2) not null check (unit_price_brl_snapshot >= 0),
  qty integer not null check (qty > 0),
  options_snapshot jsonb,
  line_total_brl numeric(10, 2) not null check (line_total_brl >= 0)
);
create index order_items_order_idx on public.order_items (order_id);

create table public.order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  from_status public.order_status,
  to_status public.order_status not null,
  actor_id uuid,
  actor_role public.user_role,
  note text,
  created_at timestamptz not null default now()
);
create index order_events_order_idx on public.order_events (order_id, created_at);

create table public.courier_positions (
  id bigint generated always as identity primary key,
  courier_id uuid not null references public.couriers (profile_id) on delete cascade,
  order_id uuid references public.orders (id) on delete cascade,
  lat numeric(9, 6) not null,
  lng numeric(9, 6) not null,
  heading numeric(5, 2),
  accuracy_m numeric(8, 2),
  recorded_at timestamptz not null default now()
);
create index courier_positions_order_idx on public.courier_positions (order_id, recorded_at desc);
create index courier_positions_recorded_idx on public.courier_positions (recorded_at); -- for the 7-day purge

alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_events enable row level security;
alter table public.courier_positions enable row level security;
