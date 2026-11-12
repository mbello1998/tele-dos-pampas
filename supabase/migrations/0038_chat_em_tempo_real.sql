-- 0038: publicar order_messages no Realtime.
--
-- Sem isto o chat funcionava pela metade, e da pior forma: a mensagem era gravada, a RLS deixava o outro
-- lado ler, e a tela dele simplesmente nunca era avisada. Quem mandou via a própria mensagem aparecer (a
-- tela recarrega depois de enviar) e achava que tinha chegado. Quem devia receber não via nada até recarregar
-- a página — num aplicativo em que o motoboy está dirigindo e o cliente esperando na calçada.
--
-- No Supabase, `postgres_changes` só entrega o que estiver na publicação `supabase_realtime`. A RLS continua
-- valendo em cima disso: publicar NÃO torna a tabela pública, só faz o canal existir para quem já podia ler.
--
-- Mesmo formato defensivo da 0025: em banco sem a publicação (um ambiente local cru), a migration não quebra.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'order_messages'
    ) then
      alter publication supabase_realtime add table public.order_messages;
    end if;
  end if;
end;
$$;
