-- 0013: textos da landing em `settings`.
--
-- A landing não escreve texto nenhum no componente: lê tudo daqui (Server Component, ver
-- src/lib/landing/content.ts, que lista as mesmas chaves). Editável pelo Supabase Studio, sem deploy.
-- Formato: cada valor é { "pt-BR": ..., "es-UY": ... }; falta de tradução cai para pt-BR.
-- Exceções, que valem para os dois idiomas: landing_cta_href e support_phone são texto simples.
--
-- `landing_headline` já nasce no seed.sql; não é repetida aqui.
-- Todas as chaves são públicas: são textos de vitrine.
--
-- PENDENTE DE CONFIRMAÇÃO DO DONO (mesmo regime do seed.sql):
--   * support_phone vai vazio de propósito. Vazio esconde o bloco de contato na landing; preencha
--     pelo Studio com o número real, com DDI (ex.: "+55 55 9...").
--   * landing_hours_notice: horário CONFIRMADO pelo dono: 06:00 a 00:00, todos os dias, para comida,
--     encomenda e corrida. É regra do município sobre o serviço. A ponte é aberta 24 horas e o texto
--     nunca deve sugerir que ela fecha.
--   * landing_cta_href aponta para a âncora da própria página enquanto o fluxo de pedido não existe;
--     quando existir, troque por "/pedir" (ou o caminho real) pelo Studio.
insert into public.settings (key, value, is_public) values
  ('landing_subheadline',
   '{"pt-BR": "Peça comida, mande uma encomenda ou chame um moto-táxi. Deste lado do rio, do outro, ou atravessando a ponte.", "es-UY": "Pedí comida, mandá un envío o llamá un moto-taxi. De este lado del río, del otro, o cruzando el puente."}',
   true),
  ('landing_cta_label',
   '{"pt-BR": "Ver como funciona", "es-UY": "Ver cómo funciona"}',
   true),
  ('landing_cta_href', '"#como-funciona"', true),
  ('landing_city_quarai',
   '{"pt-BR": "Quaraí", "es-UY": "Quaraí"}',
   true),
  ('landing_city_artigas',
   '{"pt-BR": "Artigas", "es-UY": "Artigas"}',
   true),
  ('landing_hours_notice',
   '{"pt-BR": "Atendemos todos os dias, das 06:00 às 00:00, nas duas cidades.", "es-UY": "Atendemos todos los días, de 06:00 a 00:00, en las dos ciudades."}',
   true),
  ('landing_support_label',
   '{"pt-BR": "Chamar no WhatsApp", "es-UY": "Escribinos por WhatsApp"}',
   true),
  ('support_phone', '""', true),
  ('landing_grid_title',
   '{"pt-BR": "Duas cidades, uma malha", "es-UY": "Dos ciudades, una sola trama"}',
   true),
  ('landing_grid_text',
   '{"pt-BR": "Quaraí e Artigas são separadas por um rio e unidas por uma ponte. As ruas que você vê aqui são as reais, as mesmas que a busca de endereço usa para achar a sua porta.", "es-UY": "Quaraí y Artigas las separa un río y las une un puente. Las calles que ves acá son las reales, las mismas que usa la búsqueda de direcciones para encontrar tu puerta."}',
   true),
  ('landing_grid_alt',
   '{"pt-BR": "Mapa das ruas reais de Quaraí e Artigas: duas malhas urbanas separadas pelo rio e ligadas pela ponte.", "es-UY": "Mapa de las calles reales de Quaraí y Artigas: dos tramas urbanas separadas por el río y unidas por el puente."}',
   true),
  ('landing_bridge_label',
   '{"pt-BR": "Ponte da Concórdia", "es-UY": "Puente de la Concordia"}',
   true),
  ('landing_services_title',
   '{"pt-BR": "Peça, mande ou vá", "es-UY": "Pedí, mandá o andá"}',
   true),
  ('landing_service_food',
   '{"pt-BR": {"title": "Pedir comida", "text": "Lanche, marmita e o que sair da cozinha dos comércios daqui, entregue onde você estiver."}, "es-UY": {"title": "Pedir comida", "text": "Lo que sale de la cocina de los comercios de acá, entregado donde estés."}}',
   true),
  ('landing_service_courier',
   '{"pt-BR": {"title": "Mandar encomenda", "text": "Um documento, uma chave, um pacote. A gente leva de um ponto a outro, inclusive para o outro lado da fronteira."}, "es-UY": {"title": "Mandar un envío", "text": "Un documento, una llave, un paquete. Lo llevamos de un punto a otro, también al otro lado de la frontera."}}',
   true),
  ('landing_service_ride',
   '{"pt-BR": {"title": "Chamar moto-táxi", "text": "Uma corrida de moto, de rua em rua, dentro da cidade ou atravessando a ponte. Na travessia, leve o seu documento."}, "es-UY": {"title": "Llamar un moto-taxi", "text": "Un viaje en moto, de calle en calle, dentro de la ciudad o cruzando el puente. Si cruzás, llevá tu documento."}}',
   true),
  ('landing_closing_title',
   '{"pt-BR": "A ponte liga as duas cidades. O Tele dos Pampas também.", "es-UY": "El puente une las dos ciudades. Tele dos Pampas también."}',
   true)
on conflict (key) do nothing;
