-- Enums shared across the schema. Roles live in the database (never in a JWT claim).
create extension if not exists btree_gist with schema extensions;

create type public.user_role as enum ('client', 'courier', 'merchant', 'fleet', 'admin');
create type public.order_kind as enum ('food', 'courier', 'ride');
create type public.order_status as enum (
  'criado', 'aguardando_loja', 'aguardando_motoboy', 'em_preparo', 'pronto',
  'aceito', 'motoboy_chegou', 'coletado', 'em_rota', 'em_viagem',
  'entregue', 'finalizado', 'cancelado'
);
create type public.payment_method as enum ('dinheiro_brl', 'dinheiro_uyu', 'pix');
create type public.merchant_kind as enum ('restaurante', 'trailer', 'loja');
create type public.address_precision as enum ('gps', 'quadra', 'rua');
create type public.route_source as enum ('osrm', 'haversine');
