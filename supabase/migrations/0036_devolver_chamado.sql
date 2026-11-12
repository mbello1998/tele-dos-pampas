-- 0036: devolver o chamado à fila — "furei o pneu, passa pra outro".
--
-- O caso real: o motoboy aceitou, está a caminho, e o pneu fura. Hoje ele não tem saída dentro do app: ou
-- some (e o cliente espera uma moto que não vem), ou liga para alguém resolver na mão. As duas são piores
-- que um botão.
--
-- ONDE A LINHA FOI TRAÇADA, e isto é decisão de produto, não limitação técnica: só se devolve o chamado
-- ANTES de pegar a carga ou o passageiro. Depois disso a sacola está na garupa dele; repassar vira um
-- encontro na rua entre dois motoboys, e nenhum botão faz isso acontecer. Nesse caso o caminho honesto é o
-- chat e o despacho — e a tela diz isso em vez de oferecer um botão que mentiria.
--
-- Por isso: `ride` volta de aceito/motoboy_chegou (ainda não embarcou) e `courier` volta de aceito (ainda
-- não coletou). `delivery` não volta: nesse fluxo aceitar JÁ É coletar.

create function public.release_order(p_order uuid, p_reason text)
  returns jsonb
  language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_uid uuid := (select auth.uid());
  v_motivo text := btrim(coalesce(p_reason, ''));
  v_volta public.order_status;
begin
  if v_uid is null then
    raise exception 'release_order: sem sessão' using errcode = 'TD001';
  end if;
  -- O motivo é obrigatório e vai para o cliente. Devolver em silêncio deixa quem espera sem explicação, que
  -- é exatamente o problema que este botão existe para resolver.
  if length(v_motivo) < 3 or length(v_motivo) > 300 then
    raise exception 'release_order: o motivo é obrigatório (3 a 300 caracteres)' using errcode = '22023';
  end if;

  select * into v_order from public.orders where id = p_order for update;
  if not found then
    raise exception 'release_order: pedido não encontrado' using errcode = 'TD002';
  end if;
  if v_order.courier_id is distinct from v_uid then
    raise exception 'release_order: o chamado não é seu' using errcode = 'TD010';
  end if;

  v_volta := case
    when v_order.kind = 'ride' and v_order.status in ('aceito', 'motoboy_chegou') then 'criado'::public.order_status
    when v_order.kind = 'courier' and v_order.status = 'aceito' then 'aguardando_motoboy'::public.order_status
    else null
  end;
  if v_volta is null then
    raise exception 'release_order: com a carga ou o passageiro a bordo, o repasse é combinado no chat'
      using errcode = '23514';
  end if;

  update public.orders
     set status = v_volta,
         courier_id = null,
         -- `accepted_at` volta a ser nulo: o pedido não está mais aceito por ninguém, e deixar o carimbo
         -- antigo faria a fila mostrar "aceito há 20 min" para um chamado que acabou de voltar.
         accepted_at = null,
         status_updated_at = now()
   where id = p_order;

  insert into public.order_events (order_id, from_status, to_status, actor_id, actor_role, note)
  values (p_order, v_order.status, v_volta, v_uid, 'courier', 'devolvido à fila: ' || v_motivo);

  -- A mensagem no chat é parte do ato, não um extra: é assim que quem está esperando fica sabendo, na mesma
  -- tela em que estava acompanhando.
  insert into public.order_messages (order_id, sender_id, sender_role, kind, body)
  values (p_order, v_uid, 'courier', 'texto', v_motivo);

  return jsonb_build_object('ok', true, 'status', v_volta);
end;
$$;

comment on function public.release_order(uuid, text) is
  'The assigned courier hands the call back to the queue, with a reason that reaches the client in the chat. Only before the goods or the passenger are aboard (ride: aceito/motoboy_chegou; courier: aceito). For delivery, accepting IS collecting, so there is nothing to hand back in software.';

revoke all on function public.release_order(uuid, text) from public, anon;
grant execute on function public.release_order(uuid, text) to authenticated;
