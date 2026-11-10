-- 6.2 Catalogo. price_brl is canonical; UYU is always derived.

create table public.catalog_categories (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  name text not null,
  sort_order integer not null default 0
);
create index catalog_categories_merchant_idx on public.catalog_categories (merchant_id);

create table public.catalog_items (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  category_id uuid references public.catalog_categories (id) on delete set null,
  name text not null,
  description text,
  price_brl numeric(10, 2) not null check (price_brl >= 0),
  photo_url text,
  is_available boolean not null default true,
  sort_order integer not null default 0
);
create index catalog_items_merchant_idx on public.catalog_items (merchant_id);

create table public.item_option_groups (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.catalog_items (id) on delete cascade,
  name text not null,
  min_select integer not null default 0 check (min_select >= 0),
  max_select integer not null default 1 check (max_select >= min_select),
  is_required boolean not null default false
);
create index item_option_groups_item_idx on public.item_option_groups (item_id);

create table public.item_options (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.item_option_groups (id) on delete cascade,
  name text not null,
  price_delta_brl numeric(10, 2) not null default 0,
  is_available boolean not null default true
);
create index item_options_group_idx on public.item_options (group_id);

alter table public.catalog_categories enable row level security;
alter table public.catalog_items enable row level security;
alter table public.item_option_groups enable row level security;
alter table public.item_options enable row level security;
