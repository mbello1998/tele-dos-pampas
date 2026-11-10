-- 0027: o motoboy só grava posição contra um pedido ATIVO (fecha o lado de escrita da Tarefa 12).
--
-- Até aqui (0016) o INSERT conferia só "o pedido é meu". Depois da entrega o motoboy ainda podia gravar
-- posições contra ele, e ninguém as lê (a policy de leitura do cliente fecha na entrega): linha que nenhum
-- papel pode ler é custo puro numa tabela de alta escrita, suja qualquer análise futura e faz o app aceitar
-- dado que não usa. A lista de status é a MESMA de private.client_may_track (0025), então o que se pode
-- gravar é exatamente o que o cliente pode ver. Posição sem pedido (motoboy parado, order_id nulo) segue
-- permitida: é o "onde estão meus motoboys" da frota.
--
-- Lista positiva: um status novo no enum nasce não gravável até alguém classificá-lo de propósito.
-- Um app de motoboy que envie um fix no instante da entrega recebe 42501 e o ignora (publishPosition
-- nunca lança).
create function private.courier_carries_active_order(p_order uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.orders o
    where o.id = p_order
      and o.courier_id = (select auth.uid())
      and o.status in ('em_preparo', 'pronto', 'aceito', 'motoboy_chegou', 'coletado', 'em_rota', 'em_viagem')
  )
$$;
revoke all on function private.courier_carries_active_order(uuid) from public;
grant execute on function private.courier_carries_active_order(uuid) to authenticated, service_role;

drop policy courier_positions_insert_own on public.courier_positions;
create policy courier_positions_insert_own on public.courier_positions for insert to authenticated
  with check (
    courier_id = (select auth.uid())
    and (select private.courier_base_city()) is not null
    and (order_id is null or private.courier_carries_active_order(order_id))
  );
