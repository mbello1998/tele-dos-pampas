-- 0037: fechar os privilégios que a tabela do chat herdou por padrão.
--
-- `create table` no schema public herda os grants padrão do Supabase, e `order_messages` nasceu com DELETE,
-- TRUNCATE, REFERENCES e TRIGGER para `authenticated`. A RLS já barrava tudo isso (não existe policy de
-- DELETE, e TRUNCATE nem olha policy) — mas o projeto inteiro revoga o privilégio ALÉM da policy, e com
-- razão: no dia em que alguém escrever uma policy permissiva por engano, o privilégio ausente é a rede que
-- segura. Foi um teste de estrutura que pegou isto, não eu.
--
-- TRUNCATE é o mais grave dos quatro: ele ignora RLS por definição. Com o grant em pé, bastava uma linha
-- para apagar a conversa inteira de todos os pedidos.

revoke delete, truncate, references, trigger on public.order_messages from authenticated;
revoke truncate, references, trigger on public.order_messages from service_role;

-- O que sobra é exatamente o que as policies usam: ler, escrever, e marcar como lida.
grant select, insert, update on public.order_messages to authenticated;

-- `anon` já está fechado pela regra geral da 0009 (revoke all + default privileges), mas explícito aqui
-- porque esta tabela guarda conversa com endereço de casa: vale repetir onde se lê.
revoke all on public.order_messages from anon;
