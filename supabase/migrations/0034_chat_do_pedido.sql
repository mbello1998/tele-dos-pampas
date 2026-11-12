-- 0034: o chat do pedido — texto, foto e localização, entre quem pediu e quem está levando.
--
-- Por que existe: a corrida acaba e o combinado fica na esquina. "Passou por mim e não me viu", "estou no
-- portão azul", "pode deixar com o vizinho". Hoje isso vira ligação, e ligação na moto é perigosa e cara.
--
-- QUEM PODE FALAR, e nada além disso: o cliente daquele pedido e o motoboy ATRIBUÍDO àquele pedido. Nem a
-- fila de motoboys, nem a loja, nem a frota. O admin lê, para resolver reclamação, e NÃO escreve: ninguém
-- deve poder se passar por um dos dois lados de uma conversa.
--
-- ENQUANTO o pedido está vivo. Depois de entregue a conversa fica legível (é prova do combinado), mas
-- ninguém escreve mais: um canal aberto para sempre vira um canal de contato entre estranhos, e o que
-- começou como "estou no portão" termina em assédio.

create table public.order_messages (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  -- Guardado no envio, não deduzido na leitura: se o motoboy for trocado, o histórico tem de continuar
  -- dizendo quem falou o quê naquele momento.
  sender_role public.user_role not null,
  kind text not null default 'texto' check (kind in ('texto', 'foto', 'local')),
  body text,
  -- foto: o caminho no bucket, nunca a URL assinada (que vence).
  photo_path text,
  -- local: onde a pessoa está. Decimal como o resto do projeto, não geography: a conta é distância curta.
  lat numeric(9, 6),
  lng numeric(9, 6),
  created_at timestamptz not null default now(),
  read_at timestamptz,

  -- Cada tipo exige o seu conteúdo e proíbe o dos outros. Sem isto entra 'foto' sem foto, e a tela quebra
  -- na mão de quem está dirigindo.
  constraint order_messages_conteudo_check check (
    case kind
      when 'texto' then body is not null and length(btrim(body)) between 1 and 1000 and photo_path is null and lat is null and lng is null
      when 'foto' then photo_path is not null and length(photo_path) between 1 and 400 and lat is null and lng is null
      when 'local' then lat is not null and lng is not null and photo_path is null
    end
  ),
  -- A mesma caixa das duas cidades usada em addresses: barra coordenada de GPS que falhou.
  constraint order_messages_regiao_check check (
    lat is null or (lat between -31.0 and -30.0 and lng between -57.0 and -56.0)
  )
);

create index order_messages_order_idx on public.order_messages (order_id, created_at);
-- Para a contagem de não lidas de quem abre a tela.
create index order_messages_unread_idx on public.order_messages (order_id, read_at) where read_at is null;

comment on table public.order_messages is
  'The order chat: text, photo and location between the client and the assigned courier. Admin reads (to settle disputes) and never writes. Writing stops when the order closes: a channel that stays open forever becomes a contact channel between strangers.';

alter table public.order_messages enable row level security;

-- Os dois lados daquele pedido. `private.` porque a policy não pode vazar a tabela orders para quem só
-- deveria ver a conversa.
create function private.fala_no_pedido(p_order uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.orders o
    where o.id = p_order
      and (o.client_id = (select auth.uid()) or o.courier_id = (select auth.uid()))
  );
$$;

create function private.pedido_aberto(p_order uuid) returns boolean
  language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.orders o
    where o.id = p_order and o.status not in ('entregue', 'finalizado', 'cancelado')
  );
$$;

revoke all on function private.fala_no_pedido(uuid), private.pedido_aberto(uuid) from public, anon;
grant execute on function private.fala_no_pedido(uuid), private.pedido_aberto(uuid) to authenticated;

create policy order_messages_select_partes on public.order_messages for select to authenticated
  using ((select private.fala_no_pedido(order_id)));

create policy order_messages_select_admin on public.order_messages for select to authenticated
  using ((select public.is_admin()));

-- INSERT: só os dois lados, só com o pedido aberto, e só em nome de si mesmo. `sender_id = auth.uid()` não é
-- formalidade: sem isso um dos lados escreveria mensagem assinada pelo outro.
create policy order_messages_insert_partes on public.order_messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and (select private.fala_no_pedido(order_id))
    and (select private.pedido_aberto(order_id))
  );

-- UPDATE existe por um motivo só: marcar como lida. A mensagem em si é imutável — conversa que pode ser
-- editada depois não serve de combinado.
create policy order_messages_update_lida on public.order_messages for update to authenticated
  using ((select private.fala_no_pedido(order_id)) and sender_id <> (select auth.uid()))
  with check ((select private.fala_no_pedido(order_id)) and sender_id <> (select auth.uid()));

create trigger order_messages_imutavel
  before update on public.order_messages
  for each row execute function private.restrict_update_columns('read_at');

-- Sem DELETE para ninguém, nem admin: apagar mensagem é apagar prova.
