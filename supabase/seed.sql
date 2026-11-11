-- Idempotent seed: safe to run on every `npm run db:migrate`.

-- Status transitions (spec section 8): forward steps plus the enumerated cancellations.
insert into public.status_transitions (kind, from_status, to_status, allowed_role) values
  -- delivery: 6 forward steps + cancellations
  ('delivery', 'criado', 'aguardando_loja', 'client'),
  ('delivery', 'aguardando_loja', 'em_preparo', 'merchant'),
  ('delivery', 'em_preparo', 'pronto', 'merchant'),
  ('delivery', 'pronto', 'coletado', 'courier'),
  ('delivery', 'coletado', 'em_rota', 'courier'),
  ('delivery', 'em_rota', 'entregue', 'courier'),
  -- client may cancel only before the kitchen/courier starts; merchant may cancel up to pronto.
  -- Admin is deliberately NOT here (see comment on status_transitions).
  ('delivery', 'criado', 'cancelado', 'client'),
  ('delivery', 'aguardando_loja', 'cancelado', 'client'),
  ('delivery', 'aguardando_loja', 'cancelado', 'merchant'),
  ('delivery', 'em_preparo', 'cancelado', 'merchant'),
  ('delivery', 'pronto', 'cancelado', 'merchant'),
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
cross join (values ('delivery'::public.order_kind), ('courier'), ('ride')) as k (kind)
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

-- ===== Tela do motoboy: um motoboy e cinco chamados de exemplo (Quarai) =====
-- Idempotente (ids fixos, on conflict do nothing, update so onde ainda esta no estado inicial). Nada aqui e real:
-- o e-mail termina em .invalid (nenhum codigo de acesso chega a ele; quem entra como o exemplo usa a API de admin),
-- os nomes dizem "exemplo", e os chamados nascem ja na fila para que a tela tenha o que mostrar.
-- Um chamado aceito sai da fila e NAO e recriado ao rodar de novo: para ver de novo, use outro id.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-4000-8000-00000000c001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'motoboy-exemplo@exemplo.invalid', '', now(), '', '', '', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-4000-8000-00000000c002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'cliente-exemplo@exemplo.invalid', '', now(), '', '', '', '', '{"provider":"email","providers":["email"]}', '{}', now(), now())
on conflict (id) do nothing;

-- O gatilho de cadastro cria o perfil como cliente; aqui ele vira o que o exemplo precisa ser.
update public.profiles set role = 'courier', full_name = 'Motoboy de Exemplo', home_city = 'quarai', country = 'BR'
where id = '00000000-0000-4000-8000-00000000c001' and role = 'client';
update public.profiles set full_name = 'Joao Cliente (exemplo)', home_city = 'quarai', country = 'BR'
where id = '00000000-0000-4000-8000-00000000c002' and full_name is null;

insert into public.couriers (profile_id, vehicle, plate, base_city, accepts_cross_border, accepts_passenger, is_online, status)
values ('00000000-0000-4000-8000-00000000c001', 'moto', 'EXE0A00', 'quarai', true, true, true, 'approved')
on conflict (profile_id) do nothing;

insert into public.orders (
  id, code, kind, client_id, merchant_id, pickup_address, dropoff_address, distance_m, crosses_border, status,
  pricing_breakdown, total_brl, currency_charged, total_charged, payment_method, created_at, status_updated_at
) values
  -- 1. entrega do Trailer do Zé, pronta para retirar (a loja e a origem; o nome da loja vem do pedido)
  ('00000000-0000-4000-8000-0000000d0001', 'EXEM01', 'delivery', '00000000-0000-4000-8000-00000000c002',
   '00000000-0000-4000-8000-000000000001',
   '{"merchantId":"00000000-0000-4000-8000-000000000001","name":"Trailer do Zé (exemplo)","address_text":"Praça central, Quaraí","city":"quarai","country":"BR","lat":-30.3875,"lng":-56.4528}',
   '{"city":"quarai","country":"BR","lat":-30.39188,"lng":-56.44848,"street_name":"Avenida 7 de Setembro","number":"1180","reference":"portão azul, ao lado da Baklizi","precision":"pin"}',
   900, false, 'pronto',
   '[{"key":"base","labelKey":"pricing.base","amountBrl":9.00}]', 9.00, 'BRL', 9.00, 'pix',
   now() - interval '4 minutes', now() - interval '4 minutes'),
  -- 2. moto-taxi, de perto
  ('00000000-0000-4000-8000-0000000d0002', 'EXEM02', 'ride', '00000000-0000-4000-8000-00000000c002', null,
   '{"city":"quarai","country":"BR","lat":-30.38812,"lng":-56.45248,"street_name":"Avenida Artigas","number":"S/N","reference":"em frente à Igreja Matriz","precision":"pin"}',
   '{"city":"quarai","country":"BR","lat":-30.37897,"lng":-56.4607,"street_name":"Rua Andrade Neves","number":"215","reference":"perto do Hospital de Caridade","precision":"pin"}',
   1700, false, 'criado',
   '[{"key":"base","labelKey":"pricing.base","amountBrl":10.00}]', 10.00, 'BRL', 10.00, 'dinheiro_brl',
   now() - interval '2 minutes', now() - interval '2 minutes'),
  -- 3. encomenda (levar uma coisa a outra pessoa), pela rua que nao esta no OpenStreetMap: so o nome e a referencia valem
  ('00000000-0000-4000-8000-0000000d0003', 'EXEM03', 'courier', '00000000-0000-4000-8000-00000000c002', null,
   '{"city":"quarai","country":"BR","lat":-30.38643,"lng":-56.45217,"street_name":"Rua sem nome (exemplo)","number":"S/N","reference":"farmácia Panvel, buscar a sacola no balcão","precision":"pin"}',
   '{"city":"quarai","country":"BR","lat":-30.37288,"lng":-56.44609,"street_name":"Rua Sílvio Ponte","number":"42","reference":"casa verde, cachorro no portão","precision":"pin"}',
   2900, false, 'aguardando_motoboy',
   '[{"key":"base","labelKey":"pricing.base","amountBrl":11.50},{"key":"night","labelKey":"pricing.night","amountBrl":3.00}]', 14.50, 'BRL', 14.50, 'pix',
   now() - interval '1 minute', now() - interval '1 minute'),
  -- 4. encomenda que CRUZA A PONTE para Artigas (outra moeda, outra taxa)
  ('00000000-0000-4000-8000-0000000d0004', 'EXEM04', 'courier', '00000000-0000-4000-8000-00000000c002', null,
   '{"city":"quarai","country":"BR","lat":-30.38714,"lng":-56.45212,"street_name":"Avenida 7 de Setembro","number":"90","reference":"Agafarma, balcão da frente","precision":"pin"}',
   '{"city":"artigas","country":"UY","lat":-30.40149,"lng":-56.45739,"street_name":"General Rivera","number":"640","reference":"casa de esquina, portão de ferro","precision":"pin"}',
   3400, true, 'aguardando_motoboy',
   '[{"key":"base","labelKey":"pricing.base","amountBrl":13.00},{"key":"cross_border","labelKey":"pricing.cross_border","amountBrl":8.00}]', 21.00, 'BRL', 21.00, 'pix',
   now() - interval '3 minutes', now() - interval '3 minutes'),
  -- 5. uma sobra, para testar o aceite sem gastar as outras
  ('00000000-0000-4000-8000-0000000d0005', 'EXEM05', 'ride', '00000000-0000-4000-8000-00000000c002', null,
   '{"city":"quarai","country":"BR","lat":-30.39069,"lng":-56.45206,"street_name":"Avenida 20 de Setembro","number":"S/N","reference":"posto Ipiranga","precision":"pin"}',
   '{"city":"quarai","country":"BR","lat":-30.37288,"lng":-56.44609,"street_name":"Rua Sílvio Ponte","number":"7","reference":"depois da lombada","precision":"pin"}',
   2300, false, 'criado',
   '[{"key":"base","labelKey":"pricing.base","amountBrl":10.00}]', 10.00, 'BRL', 10.00, 'dinheiro_brl',
   now() - interval '30 seconds', now() - interval '30 seconds')
on conflict (id) do nothing;
