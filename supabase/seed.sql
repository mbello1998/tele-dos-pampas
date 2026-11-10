-- Idempotent seed: safe to run on every `npm run db:migrate`.

-- Status transitions (spec section 8): forward steps plus the enumerated cancellations.
insert into public.status_transitions (kind, from_status, to_status, allowed_role) values
  -- food: 6 forward steps + cancellations
  ('food', 'criado', 'aguardando_loja', 'client'),
  ('food', 'aguardando_loja', 'em_preparo', 'merchant'),
  ('food', 'em_preparo', 'pronto', 'merchant'),
  ('food', 'pronto', 'coletado', 'courier'),
  ('food', 'coletado', 'em_rota', 'courier'),
  ('food', 'em_rota', 'entregue', 'courier'),
  -- client may cancel only before the kitchen/courier starts; merchant may cancel up to pronto.
  -- Admin is deliberately NOT here (see comment on status_transitions).
  ('food', 'criado', 'cancelado', 'client'),
  ('food', 'aguardando_loja', 'cancelado', 'client'),
  ('food', 'aguardando_loja', 'cancelado', 'merchant'),
  ('food', 'em_preparo', 'cancelado', 'merchant'),
  ('food', 'pronto', 'cancelado', 'merchant'),
  -- courier: 4 forward steps + cancellations
  ('courier', 'criado', 'aguardando_motoboy', 'client'),
  ('courier', 'aguardando_motoboy', 'aceito', 'courier'),
  ('courier', 'aceito', 'coletado', 'courier'),
  ('courier', 'coletado', 'entregue', 'courier'),
  ('courier', 'criado', 'cancelado', 'client'),
  ('courier', 'aguardando_motoboy', 'cancelado', 'client'),
  -- ride: 4 forward steps + cancellation
  ('ride', 'criado', 'aceito', 'courier'),
  ('ride', 'aceito', 'motoboy_chegou', 'courier'),
  ('ride', 'motoboy_chegou', 'em_viagem', 'courier'),
  ('ride', 'em_viagem', 'finalizado', 'courier'),
  ('ride', 'criado', 'cancelado', 'client')
on conflict do nothing;

-- Default pricing rules: one open-ended version per (city, kind).
insert into public.pricing_rules (
  city, kind, base_fare_brl, included_km, per_km_brl, min_fare_brl,
  night_surcharge_brl, night_from, night_to, cross_border_fee_brl, passenger_cross_border_fee_brl,
  valid_from
)
select c.city, k.kind, 10.00, 2.0, 2.50, 10.00, 3.00, '23:00', '05:00', 8.00, 12.00, date '2026-01-01'
from (values ('quarai'), ('artigas')) as c (city)
cross join (values ('food'::public.order_kind), ('courier'), ('ride')) as k (kind)
where not exists (
  select 1 from public.pricing_rules p where p.city = c.city and p.kind = k.kind
);

-- Settings. service_radius_km is 5 (the owner's ruling: Quaraí spans ~7 km, and `zones` decides whether
-- an address is served). There is NO bridge_hours key: the bridge is open 24 hours, and the only time
-- limit is the municipal service window (06:00-00:00), which lives in settings['service_hours'] and is
-- written by migration 0010. Do not seed bridge_hours: this file runs on every db:migrate and would revive it.
-- (public keys are readable by anonymous visitors once RLS policies exist).
insert into public.settings (key, value, is_public) values
  ('service_radius_km', '5', true),
  ('unserved_zone_message', '{"pt-BR": "Ainda não atendemos esta região.", "es-UY": "Todavía no atendemos esta zona."}', true),
  ('landing_headline', '{"pt-BR": "Tele-entrega, moto-táxi e encomendas em Quaraí e Artigas.", "es-UY": "Delivery, moto-taxi y encomiendas en Quaraí y Artigas."}', true)
on conflict (key) do nothing;

-- Example merchants (unowned until claimed): a trailer in Quaraí and a restaurant in Artigas.
insert into public.merchants (
  id, name, kind, city, country, address_text, lat, lng, prep_time_min,
  commission_pct, accepts_cross_border, status
) values
  ('00000000-0000-4000-8000-000000000001', 'Trailer do Zé (exemplo)', 'trailer', 'quarai', 'BR',
   'Praça central, Quaraí', -30.387500, -56.452800, 15, 10.00, true, 'approved'),
  ('00000000-0000-4000-8000-000000000002', 'Restaurante La Frontera (ejemplo)', 'restaurante', 'artigas', 'UY',
   'Centro, Artigas', -30.400000, -56.470000, 25, 10.00, true, 'approved')
on conflict (id) do nothing;

-- ===== Dados de demonstracao (catalogo, horarios e opcoes) =====
-- Idempotente. Trailer de Quarai com janela que cruza a meia-noite (06:00-00:00);
-- restaurante de Artigas com janela simples (08:00-23:00). De proposito: exercita os dois caminhos.
-- Horarios: o trailer de Quarai usa janela que CRUZA a meia-noite (06:00-00:00),
-- o restaurante de Artigas usa janela simples (08:00-23:00). De proposito: exercita os dois caminhos.
insert into public.merchant_hours (id, merchant_id, weekday, opens_at, closes_at)
select ('00000000-0000-4000-8000-0000000100'||lpad(d::text,2,'0'))::uuid,
       '00000000-0000-4000-8000-000000000001'::uuid, d, '06:00', '00:00'
from generate_series(0,6) d
on conflict (id) do nothing;

insert into public.merchant_hours (id, merchant_id, weekday, opens_at, closes_at)
select ('00000000-0000-4000-8000-0000000200'||lpad(d::text,2,'0'))::uuid,
       '00000000-0000-4000-8000-000000000002'::uuid, d, '08:00', '23:00'
from generate_series(0,6) d
on conflict (id) do nothing;

-- Categorias
insert into public.catalog_categories (id, merchant_id, name, sort_order) values
 ('00000000-0000-4000-8000-000000001101','00000000-0000-4000-8000-000000000001','Xis',1),
 ('00000000-0000-4000-8000-000000001102','00000000-0000-4000-8000-000000000001','Bebidas',2),
 ('00000000-0000-4000-8000-000000001201','00000000-0000-4000-8000-000000000002','Platos',1),
 ('00000000-0000-4000-8000-000000001202','00000000-0000-4000-8000-000000000002','Bebidas',2)
on conflict (id) do nothing;

-- Itens (price_brl e a moeda canonica, inclusive para a loja uruguaia)
insert into public.catalog_items (id, merchant_id, category_id, name, description, price_brl, is_available, sort_order) values
 ('00000000-0000-4000-8000-000000002101','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000001101','Xis de coração','Pão, coração de galinha, queijo, alface e tomate',32.00,true,1),
 ('00000000-0000-4000-8000-000000002102','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000001101','Xis salada','Pão, hambúrguer, queijo, alface, tomate e maionese',28.00,true,2),
 ('00000000-0000-4000-8000-000000002103','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000001102','Coca-Cola lata','350 ml',7.00,true,1),
 ('00000000-0000-4000-8000-000000002104','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000001102','Água mineral','500 ml',4.00,true,2),
 ('00000000-0000-4000-8000-000000002201','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000001201','Chivito al plato','Lomo, jamón, queso, huevo y papas fritas',45.00,true,1),
 ('00000000-0000-4000-8000-000000002202','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000001201','Milanesa con papas','Milanesa de carne con papas fritas',38.00,true,2),
 ('00000000-0000-4000-8000-000000002203','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000001202','Refresco','Lata 350 ml',8.00,true,1),
 ('00000000-0000-4000-8000-000000002204','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000001202','Agua mineral','500 ml',5.00,true,2)
on conflict (id) do nothing;

-- Grupos de opcao: um obrigatorio de escolha unica, um opcional com multiplos
insert into public.item_option_groups (id, item_id, name, min_select, max_select, is_required) values
 ('00000000-0000-4000-8000-000000003101','00000000-0000-4000-8000-000000002101','Ponto da carne',1,1,true),
 ('00000000-0000-4000-8000-000000003102','00000000-0000-4000-8000-000000002101','Adicionais',0,3,false)
on conflict (id) do nothing;

insert into public.item_options (id, group_id, name, price_delta_brl, is_available) values
 ('00000000-0000-4000-8000-000000004101','00000000-0000-4000-8000-000000003101','Ao ponto',0.00,true),
 ('00000000-0000-4000-8000-000000004102','00000000-0000-4000-8000-000000003101','Bem passado',0.00,true),
 ('00000000-0000-4000-8000-000000004103','00000000-0000-4000-8000-000000003102','Bacon',4.00,true),
 ('00000000-0000-4000-8000-000000004104','00000000-0000-4000-8000-000000003102','Ovo',3.00,true),
 ('00000000-0000-4000-8000-000000004105','00000000-0000-4000-8000-000000003102','Cheddar',3.00,true)
on conflict (id) do nothing;

-- URL dos tiles do mapa (trocavel sem deploy; a politica do OSM proibe trafego pesado)
insert into public.settings (key, value, is_public) values ('map.tile_url', '"https://tile.openstreetmap.org/{z}/{x}/{y}.png"'::jsonb, true) on conflict (key) do nothing;
