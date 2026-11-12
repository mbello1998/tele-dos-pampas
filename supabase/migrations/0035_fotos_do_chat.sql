-- 0035: o depósito das fotos do chat.
--
-- Bucket PRIVADO. Foto de chat mostra a porta da casa de alguém, o portão, às vezes a pessoa. Bucket público
-- seria uma pasta de fotos de endereços de Quaraí aberta na internet para quem adivinhasse o caminho.
-- Quem lê a foto lê por URL assinada, de curta duração, emitida pelo servidor para quem é parte do pedido.
--
-- O CAMINHO CARREGA A AUTORIZAÇÃO: `<order_id>/<arquivo>`. A policy lê a primeira pasta do caminho e pergunta
-- à mesma função do chat se quem está pedindo fala naquele pedido. Sem essa convenção, qualquer parte de um
-- pedido leria a foto de outro.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-fotos', 'chat-fotos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 5 MB e só três formatos: é foto de celular tirada na rua, não arquivo de design. O limite também é a
-- defesa contra alguém usar o bucket de disco de graça.

create policy chat_fotos_select_partes on storage.objects for select to authenticated
  using (
    bucket_id = 'chat-fotos'
    and (select private.fala_no_pedido(((storage.foldername(name))[1])::uuid))
  );

create policy chat_fotos_insert_partes on storage.objects for insert to authenticated
  with check (
    bucket_id = 'chat-fotos'
    and (select private.fala_no_pedido(((storage.foldername(name))[1])::uuid))
    and (select private.pedido_aberto(((storage.foldername(name))[1])::uuid))
    and owner = (select auth.uid())
  );

-- Sem UPDATE e sem DELETE: foto trocada depois não serve de prova, e apagada também não.
