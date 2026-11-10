-- 0025: privacidade da posição do motoboy (Tarefa 12, rastreio em tempo real).
--
-- A posição de um motoboy é dado pessoal sensível: diz onde uma pessoa está, minuto a minuto. Quem pode ler
-- courier_positions:
--
--   o cliente DAQUELE pedido   só enquanto o pedido está ativo, e só as posições do motoboy que o carrega
--   o próprio motoboy          as suas (courier_positions_select_own, 0009)
--   a frota do motoboy         só posições recentes (15 min): "onde estão meus motoboys agora", não o histórico
--   o admin                    tudo (courier_positions_select_admin, 0009)
--
-- Ninguém mais, em momento nenhum: outro cliente, outro motoboy, o lojista do pedido, uma frota que não é a
-- dele, anônimo. Quando o pedido é entregue (ou cancelado), a policy do cliente fecha na hora, e como o
-- Realtime avalia a policy de leitura de cada assinante, o fluxo ao vivo seca junto.
--
-- Fecha por padrão: não existe policy de escrita nova (inserir continua restrito a quem carrega o pedido,
-- 0016) e nenhum papel de API altera ou apaga posição.

-- ---------------------------------------------------------------------------------------------
-- 1. O cliente do pedido, enquanto ele está ativo
-- ---------------------------------------------------------------------------------------------
-- Lista POSITIVA de status. Um status novo no enum nasce invisível (fecha) até alguém classificá-lo de
-- propósito aqui; uma lista negra de terminais (<> 'entregue') abriria sozinha. O espelho em TypeScript é
-- TRACKING_ACTIVE_STATUSES (src/lib/realtime/position.ts) e tests/db/position-privacy.test.ts compara os dois.
--
-- Por que cada status:
--   em_preparo, pronto         comida: o motoboy aceita na fila de 'pronto' e segue 'pronto' até coletar;
--   aceito, motoboy_chegou     encomenda e corrida: o motoboy está indo até o cliente;
--   coletado, em_rota          a caminho da entrega; em_viagem é a corrida em andamento.
-- Fora: criado, aguardando_loja, aguardando_motoboy (ainda não há motoboy), entregue, finalizado, cancelado.
--
-- A posição tem de ser do motoboy ATUAL do pedido: se o pedido foi repassado, as posições do motoboy
-- anterior deixam de aparecer para o cliente. SECURITY DEFINER para consultar orders sem depender da RLS
-- dela (o cliente lê o próprio pedido, mas a frota e o motoboy não leem orders direto, e esta função é a
-- mesma peça usada por todos os caminhos). Fica em `private`, que o PostgREST não expõe.
create function private.client_may_track(p_order uuid, p_courier uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.orders o
    where o.id = p_order
      and o.client_id = (select auth.uid())
      and (select public.app_role()) is not null
      and o.courier_id = p_courier
      and o.status in ('em_preparo', 'pronto', 'aceito', 'motoboy_chegou', 'coletado', 'em_rota', 'em_viagem')
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. A frota: motoboys da própria frota, posições recentes
-- ---------------------------------------------------------------------------------------------
-- "Onde estão meus motoboys agora". Uma janela curta no lugar do histórico: sem ela, quem recrutasse um
-- motoboy leria semanas de deslocamentos dele de antes (a retenção é de 7 dias). owned_fleet_ids() só devolve
-- frota aprovada de dono ativo com papel 'fleet', então frota pendente ou dono bloqueado não lê nada.
create function private.fleet_may_see_position(p_courier uuid, p_recorded timestamptz) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.couriers c
    where c.profile_id = p_courier
      and c.fleet_id in (select private.owned_fleet_ids())
  )
  and p_recorded > now() - interval '15 minutes'
$$;

revoke all on function private.client_may_track(uuid, uuid), private.fleet_may_see_position(uuid, timestamptz) from public;
grant execute on function private.client_may_track(uuid, uuid), private.fleet_may_see_position(uuid, timestamptz)
  to authenticated, service_role;

create policy courier_positions_select_client on public.courier_positions for select to authenticated
  using (private.client_may_track(order_id, courier_id));

create policy courier_positions_select_fleet on public.courier_positions for select to authenticated
  using (private.fleet_may_see_position(courier_id, recorded_at));

-- ---------------------------------------------------------------------------------------------
-- 3. Canal em tempo real
-- ---------------------------------------------------------------------------------------------
-- Realtime (postgres_changes) respeita a RLS de quem escuta: o assinante só recebe linhas que as policies
-- acima deixam ele ler. order_events entra para a timeline (toda mudança de status grava um evento).
-- `orders` NÃO entra: carrega valores e comissão, e o rastreio não precisa dela no canal.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'courier_positions'
    ) then
      alter publication supabase_realtime add table public.courier_positions;
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'order_events'
    ) then
      alter publication supabase_realtime add table public.order_events;
    end if;
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Provedor de tiles: uma setting, nunca uma constante no código
-- ---------------------------------------------------------------------------------------------
-- A política de uso do OpenStreetMap (tile.openstreetmap.org) não permite tráfego pesado. O provedor precisa
-- poder ser trocado (Carto, Stadia, MapTiler, auto-hospedado) pelo Studio, sem deploy: basta mudar o valor
-- de map.tile_url, um modelo com {z}, {x} e {y}, e o crédito em map.tile_attribution. Públicas: o navegador
-- precisa delas. Se o dono já definiu, não sobrescreve.
insert into public.settings (key, value, is_public) values
  ('map.tile_url', '"https://tile.openstreetmap.org/{z}/{x}/{y}.png"', true),
  ('map.tile_attribution', '"© OpenStreetMap"', true)
on conflict (key) do nothing;
