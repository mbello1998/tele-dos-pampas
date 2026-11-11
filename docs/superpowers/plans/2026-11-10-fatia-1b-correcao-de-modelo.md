# Fatia 1b — Correção de modelo: de marketplace para transporte

**Data:** 10/11/2026
**Spec:** `docs/superpowers/specs/2026-11-09-tele-dos-pampas-design.md`, **seção 0** (que supersede o resto)
**Origem:** correção do dono do negócio. O produto é transporte no estilo Uber/99, não venda de comida.

## A proposta, nas palavras do dono

> "no início do site quero que tenha como fosse pedir uma corrida, essa é a proposta — quando você abre o app da Uber o que aparece primeiro é pedir corrida"
> "eu sou dono de restaurante, vou lá e só insiro o endereço do meu cliente, o app vai calcular tudo, vou lá só coloco o preço a pagar pro motoboy e pronto"
> "a tela do motoboy é basicamente pra saber se tem chamado do restaurante X ou do cliente tal"

Três frases que definem três telas. O resto é consequência.

---

## Princípio que muda tudo: a tela inicial é o pedido

Hoje `/` é uma landing institucional: manchete, seções, malha animada, um botão que leva a uma âncora. Isso é site de divulgação. **Uber não tem landing** — abre no mapa com "para onde?".

Então: **`/` passa a ser o formulário de pedido**, sem login, sem porta. A identidade visual (malha das duas cidades, paleta pampa, guarda pampa) não morre — ela passa a ser o **fundo** da tela de pedido, não uma página separada. A landing atual vira `/sobre`, para quem chegar por link de divulgação.

**Login sai do caminho.** Ninguém cria conta para ver quanto custa. A conta aparece **só no confirmar**, e é aí que o OTP importa.

---

## Passo 1 — Apagar o marketplace

Sai do código: `src/app/(cliente)/lojas/**`, `src/components/catalog/**`, `src/components/order/Cart.tsx`, `PriceSummary.tsx` na forma atual, `src/lib/cart/**`, `tests/unit/cart.test.ts`, `tests/e2e/catalog.spec.ts`.

Sai do banco (migration nova): `catalog_categories`, `catalog_items`, `item_option_groups`, `item_options`, `order_items`, `merchants.commission_pct`, e os dados de demonstração de cardápio no `seed.sql`. `order_commissions` deixa de ser comissão de venda — ou cai, ou passa a fração da taxa de entrega via `pricing_rules.service_fee_pct`.

Sai do `0028`: a abertura pública do catálogo (as lojas não são mais vitrine). `merchants_public` continua útil, agora só para o motoboy e o despacho verem nome e coordenada da loja.

**Preservar com cuidado:** `merchant_hours` e `is_within_service_hours` continuam, porque a regra municipal de 06:00–00:00 vale para o serviço de entrega inteiro. O que muda é que o horário da loja deixa de bloquear o cliente e passa a ser informação operacional.

---

## Passo 2 — `/` é pedir corrida

Uma tela, três abas (ou três botões grandes, decisão de execução):

**Mototáxi** — de onde · para onde · preço estimado · confirmar
**Encomenda** — coleta · entrega · o que é · preço estimado · confirmar
**Entrega da minha loja** — visível a quem está logado como `merchant`

Cada endereço usa o seletor já construído (busca nas 512 ruas, quadra, pino, referência obrigatória, saída para rua fora do mapa). O preço aparece **antes** de pedir conta, calculado no servidor pela função que já existe.

No confirmar: se não há sessão, pede o código; com sessão, cria o pedido.

---

## Passo 3 — A tela da loja

O que o dono faz, e nada além disso:

1. **Endereço do cliente dele** — o seletor já existe
2. **O que vai na sacola** — texto livre, "2 xis de coração, 1 coca"
3. **Valor a receber do cliente** — opcional, com troco e conversão para pesos
4. **Quanto pagar ao motoboy** — o app calcula e **sugere** pela tabela; o dono pode ajustar
5. **Quem paga a entrega** — cliente final ou a loja, por pedido

A coleta é **sempre a coordenada da própria loja**, nunca digitada.

### CORRIGIDO pelo dono em 10/11/2026 — a plataforma calcula, o dono não digita

Minha leitura anterior (o app sugere, o dono ajusta) **estava errada**. As palavras dele: *"o valor deve ser calculado pela plataforma"*.

O exemplo que ele deu define a estrutura: **Tropical Lanches, na 7 de Setembro, em Quaraí → Bairro Gaudêncio Conceição = R$ 9,00**. A plataforma lança esse valor, e lança para os dois lados.

**Duas tabelas de tarifa, não uma.** Mesma rota, dois preços, porque são dois públicos:

| Quem pede | Nome | O exemplo |
|---|---|---|
| cliente final (mototáxi, encomenda) | **tarifa de balcão** | R$ 9,00 |
| loja com convênio (`delivery`) | **tarifa de convênio** | R$ 8,00 |

A loja paga menos **por ter convênio com a plataforma** — é isso que ela compra ao se cadastrar. O motoboy recebe o que a tabela daquele público manda; o dono não negocia na tela.

**Quem edita as tarifas: o dono da tele**, não só o admin. Hoje `pricing_rules` é escrita só por `admin` e a RLS tem de abrir para `fleet`.

Consequências no modelo:
- `pricing_rules` ganha a dimensão de público (`client` | `merchant`), de modo que cada `(cidade, kind, público)` tem tarifa própria e vigência própria.
- O guard de histórico continua: mudar preço é **linha nova datada**, nunca edição no lugar. Toda alteração de tarifa fica auditável — quem mudou, quando, de quanto para quanto.
- `pricing_rules` **não tem `fleet_id`**. Com uma tele na cidade isso é indiferente; com duas, a tabela passa a ser disputada. Fica registrado como a primeira coisa a resolver se aparecer uma segunda tele.
- O princípio "preço é do servidor, nunca do cliente" **volta a valer inteiro**, inclusive para a loja. Nada de valor vindo da tela.

## Passo 4 — A tela do motoboy

Uma lista, ordenada por chegada: **quem chamou** (Trailer do Zé, ou João), **de onde para onde**, **quanto ele recebe**, **a que distância está**. Aceitar com um toque. Nada mais nesta fatia.

Usa `private.effective_radius_km()` para filtrar o que ele vê, e a fila por cidade que já existe.

---

## Passo 5 — Banco

Renomear `food` para `delivery` no enum, e em `status_transitions`, `pricing_rules` e nos testes.

Colunas novas em `orders`: `load_description` (texto), `collect_amount_brl` (nulável), `delivery_fee_payer` (`client` | `merchant`), `courier_fee_brl` (o valor que o dono definiu).

`create_order` ganha o caminho de `delivery`: sem itens, sem subtotal, coleta na loja, exige que quem chama seja o dono daquela loja. A autorização deixa de ser "papel é `client`" e passa a depender do `kind`.

`quote_order` ganha o ramo sem itens: taxa de entrega, zona, noturno, travessia, conversão — sem subtotal e sem comissão.

---

## Passo 6 — Login que funciona

O OTP por e-mail está pedindo código e o código não chega. Duas causas conhecidas: os templates do Supabase precisam conter `{{ .Token }}`, e o SMTP padrão do Supabase só entrega para membros do projeto e é limitado.

Nesta fatia: **login sai do caminho** para tudo que é consulta, então o bloqueio deixa de impedir ver o app. Para confirmar pedido, o caminho honesto é SMS (que é o que Quaraí usa de verdade) ou um provedor de e-mail próprio. Decisão do dono, com custo.

---

## Ordem de execução

1. Apagar o marketplace e renomear `food` → `delivery` *(uma tarefa, porque a renomeação atravessa o que vai ser apagado)*
2. `/` como tela de pedido, com mototáxi e encomenda funcionando ponta a ponta
3. Tela da loja
4. Tela do motoboy
5. Limpeza: `/sobre`, textos, o que sobrou de comissão

Testes: por decisão do dono, não se escreve teste novo nesta fatia. O que já existe continua rodando, e o que ficar obsoleto é corrigido ou removido com o motivo registrado.
