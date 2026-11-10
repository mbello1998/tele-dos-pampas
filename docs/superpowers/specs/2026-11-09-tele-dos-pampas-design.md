# Tele dos Pampas — documento de design

**Data:** 09/11/2026
**Status:** aprovado em brainstorming, aguardando plano de implementação
**Escopo deste documento:** arquitetura geral do produto + especificação completa da Fatia 1

---

## 1. Intenção

Plataforma de tele-entrega e mototáxi operando simultaneamente em **Quaraí (RS, Brasil)** e **Artigas (Uruguai)** — duas cidades separadas por uma ponte e tratadas, na prática, como uma só área urbana.

O diferencial não é ser "um iFood menor". É ser **binacional e bimonetário**: um morador de Artigas pede pagando em pesos uruguaios, um morador de Quaraí pede pagando em reais, os mesmos motoboys atendem os dois lados, e o mesmo restaurante vende para os dois países. Nenhuma plataforma grande faz isso ali.

### Definição de sucesso

1. O motoboy abre no celular dele e trabalha, sem treinamento.
2. O dono do trailer muda o preço do xis às 19h sem precisar ligar pra ninguém.
3. O cliente encontra a rua dele digitando três letras, e o motoboy acha a casa pela referência escrita.
4. O admin altera taxa, raio, câmbio, textos e banners sem deploy.
5. Abre rápido num Android de entrada com dados móveis contados.

### Público e contexto operacional

- Clientes: moradores das duas cidades, maioria em Android de entrada, 3G/4G instável.
- Motoboys: autônomos que já rodam na cidade, celular no suporte, trabalho noturno.
- Comerciantes: restaurantes e **trailers** (lanche de rua), operação informal, pouca paciência para software.
- Volume inicial esperado: dezenas de pedidos por dia, não milhares.

---

## 2. Decisões tomadas no brainstorming

| Tema | Decisão |
|---|---|
| Natureza | Produto real com backend (não protótipo) |
| Stack | Next.js 15 App Router + Supabase, deploy Netlify |
| Mapa | Dataset OSM local + Leaflet, sem Google Maps API |
| Rota/distância | OSRM público com fallback haversine × 1,35 |
| Pagamento | Sem gateway: dinheiro, Pix exibido, pesos em espécie com troco |
| Papéis | Cinco: `client`, `courier`, `merchant`, `fleet`, `admin` |
| Fronteira | Tudo cruza a ponte, inclusive passageiro |
| Estética | Pampa noturno, acento sol dourado, malha de ruas real como elemento gráfico |
| Remotion | Hero, onboarding em tela cheia e vídeos verticais de divulgação |
| GSAP/SVG | Widgets de status do pedido, movimento do app e scroll da landing |

### Suposições assumidas (corrigir se erradas)

- Uma instância única serve as duas cidades.
- Interface em PT-BR e ES, detectada e trocável.
- **Idioma e moeda são independentes**: um brasileiro pode visualizar em pesos.
- Sem frota própria: motoboys se cadastram e o admin aprova.
- Sem CNPJ/gateway na Fatia 1.

---

## 3. Decomposição em fatias

Cada fatia recebe sua própria spec, plano e ciclo de implementação. **Este documento especifica apenas a Fatia 1.**

| # | Fatia | Entrega |
|---|---|---|
| **1** | **Fundação + cliente pede de uma loja** | Auth e papéis, RLS, dataset de endereços, motor de preço, câmbio, catálogo lido, pedido criado e acompanhado, identidade visual, landing |
| 2 | Painel do merchant | Login do restaurante/trailer, CRUD de cardápio, horários, aceitar/recusar, "fechado agora" |
| 3 | App do motoboy | Fila, aceite, máquina de estados, transmissão de posição, ganhos |
| 4 | Painel do fleet | Motoboys, escala, taxa, repasse, relatórios |
| 5 | Painel admin completo | Aprovações, settings, zonas, auditoria, CMS da landing |
| 6 | Camada Remotion | Hero data-driven, onboarding, gerador de vídeo vertical |

Ordem justificada: sem catálogo o cliente não tem o que pedir, então a Fatia 1 inclui **leitura** de catálogo com dados semeados pelo admin, e a **escrita** pelo merchant vem na Fatia 2.

**Lacuna da Fatia 1 e como ela é fechada:** se o app do motoboy só existe na Fatia 3, um pedido criado na Fatia 1 não tem quem o aceite, e o fluxo não seria testável ponta a ponta. Para evitar isso, a Fatia 1 inclui um **console de despacho mínimo para o `admin`**: uma tabela de pedidos ativos com os botões de transição de status permitidos pela máquina de estados, para o admin atribuir motoboy e mover o pedido manualmente — exatamente como uma tele opera hoje por rádio e telefone. Não é tela bonita nem é o painel admin completo (Fatia 5); é o mínimo para o ciclo fechar e para a operação poder começar antes de os outros painéis existirem.

---

## 4. Arquitetura

### 4.1 Princípios

1. **Preço e permissão vivem no Postgres, nunca no navegador.** O cliente envia intenção (origem, destino, tipo, itens); o servidor devolve o valor. Qualquer cálculo de preço no cliente é apenas estimativa visual e é recalculado no servidor antes de gravar.
2. **Segurança é RLS, não rota escondida.** `/admin` protegida no middleware é conveniência; a garantia é o Postgres recusar a linha.
3. **Tudo que o admin edita é linha de tabela, não constante no código.**
4. **Dados históricos são imutáveis.** Pedido guarda cópia congelada de preço, regra, cotação e itens.
5. **Degradação graciosa.** Sem OSRM, sem FX, sem tiles de mapa, o app continua aceitando pedido.

### 4.2 Alternativas descartadas

- **SPA Vite + Supabase:** joga lógica de preço no cliente, editável no DevTools. Inaceitável num app que move dinheiro.
- **Backend próprio Node/Fastify + Postgres:** reimplementaria à mão auth, realtime e permissões que o Supabase já entrega auditados. Custo sem retorno nesta escala.

### 4.3 Camadas

- **Next.js 15 App Router** — Server Components para leitura, Server Actions para escrita. Nenhuma Server Action confia em valor de preço vindo do cliente.
- **Supabase** — Postgres, Auth (telefone/OTP como primário, e-mail como alternativa), RLS, Realtime, Storage (fotos de produto).
- **Netlify** — deploy, variáveis de ambiente, cron (atualização de câmbio).
- **Dataset estático** — `public/data/quarai.json`, `public/data/artigas.json`, versionados no repositório.

---

## 5. Papéis e segurança

### 5.1 Os cinco papéis

| Papel | Escopo |
|---|---|
| `client` | Pede, acompanha o próprio pedido, avalia, gerencia os próprios endereços |
| `courier` | Vê fila da cidade onde está habilitado, aceita, move status operacionais, transmite posição |
| `merchant` | Dono do próprio negócio: cardápio, preço, horário, pedidos da própria loja |
| `fleet` | Dono da tele: motoboys, escala, taxa de entrega, pedidos atendidos pela própria frota |
| `admin` | Site inteiro, aprovações, settings, auditoria |

`merchant` e `fleet` são negócios distintos e **não se enxergam financeiramente**: `fleet` nunca lê faturamento de loja, `merchant` nunca lê repasse de motoboy.

### 5.2 Camadas de segurança (defesa em profundidade)

1. **Auth** — Supabase Auth, OTP por telefone. Nenhuma senha armazenada por nós.
2. **Papel** — `profiles.role`, enum no banco. Não vem de claim de JWT editável pelo cliente; é lido por função `security definer` a partir de `auth.uid()`.
3. **RLS em todas as tabelas**, sem exceção, inclusive `settings` (leitura pública apenas das chaves marcadas `is_public`).
4. **Transições de status validadas no banco** por tabela de transições permitidas (`from_status`, `to_status`, `allowed_role`), não por condicional no front.
5. **Preço recalculado no servidor** na criação do pedido; divergência maior que um centavo rejeita a requisição e registra em `audit_log`.
6. **Rate limit** na criação de pedido e no envio de posição.
7. **Auditoria** — toda escrita de `admin`, `fleet` ou `merchant` em dado sensível grava em `audit_log` com ator, antes/depois e timestamp.
8. **Privacidade de localização** — posição de motoboy legível só pelo cliente do pedido ativo e pelo fleet dele, e somente enquanto o pedido estiver em andamento.

---

## 6. Modelo de dados

### 6.1 Pessoas e negócios

**`profiles`** — `id` (FK `auth.users`), `role`, `full_name`, `phone`, `locale` (`pt-BR` | `es-UY`), `currency_pref` (`BRL` | `UYU`), `home_city`, `country`, `status` (`active` | `pending` | `blocked`), `created_at`.
Idioma e moeda são campos separados e independentes.

**`merchants`** — `id`, `owner_id` (FK `profiles`), `name`, `kind` (`restaurante` | `trailer` | `loja`), `city`, `country`, `address_text`, `lat`, `lng`, `phone`, `prep_time_min`, `commission_pct`, `is_open_manual` (booleano que o dono aperta quando acaba o gás), `accepts_cross_border`, `status` (`pending` | `approved` | `suspended`), `logo_url`, `cover_url`.

**`merchant_hours`** — `merchant_id`, `weekday` (0-6), `opens_at`, `closes_at`. Múltiplas faixas por dia permitidas (almoço e noite).
Loja está aberta se: `status = approved` **e** `is_open_manual = true` **e** hora atual dentro de uma faixa.

**`couriers`** — `profile_id`, `vehicle` (`moto` | `bike` | `carro`), `plate`, `base_city`, `accepts_cross_border`, `accepts_passenger`, `is_online`, `is_available`, **`work_radius_km`**, `rating_avg`, `fleet_id` (FK `fleets`, nulável para autônomo), `status`.

**`fleets`** — `id`, `owner_id`, `name`, `city`, `phone`, **`max_radius_km`**, `status`.

#### Raio de trabalho: hierarquia e visibilidade

O raio de atendimento não é um número único do sistema. São três camadas, da mais ampla para a mais estreita:

1. **`settings['service_radius_km']`** — teto global do produto, só o admin muda.
2. **`fleets.max_radius_km`** — o dono da tele define o **máximo** que a frota dele atende.
3. **`couriers.work_radius_km`** — cada motoboy escolhe o raio em que quer trabalhar, **sempre dentro do máximo da frota**. Um trigger rejeita valor acima do teto do dono; quando o dono reduz o máximo, os motoboys acima dele são ajustados para baixo no mesmo comando, e cada ajuste gera evento.

Motoboy autônomo (`fleet_id` nulo) é limitado apenas pelo teto global.

**`courier_events`** — `id`, `courier_id`, `fleet_id` (copiado no momento do evento, para o histórico sobreviver à troca de frota), `kind` (`radius_changed` | `went_online` | `went_offline` | `became_available` | `became_busy` | `capped_by_fleet`), `from_value`, `to_value`, `actor_id`, `created_at`.

Gravada por trigger em `couriers`, nunca pela aplicação — assim nenhum caminho de código pode mudar o estado do motoboy sem deixar rastro. **O dono da tele lê os eventos dos motoboys da própria frota**, o motoboy lê os seus, o admin lê todos; mais ninguém. É isso que responde "quem trocou o raio, quem ficou disponível, quem saiu" sem o dono precisar perguntar.

Esta tabela é separada de `audit_log` de propósito: `audit_log` é artefato de segurança de leitura exclusiva do admin, e alargar a RLS dele para incluir donos de frota criaria um caminho de vazamento. `courier_events` é um feed operacional, desenhado para ser lido pelo dono.

### 6.2 Catálogo

**`catalog_categories`** — `id`, `merchant_id`, `name`, `sort_order`.

**`catalog_items`** — `id`, `merchant_id`, `category_id`, `name`, `description`, `price_brl` (**numeric, moeda canônica**), `photo_url`, `is_available`, `sort_order`.
Preço canônico sempre em BRL; exibição em UYU é derivada da cotação vigente. Um merchant uruguaio informa em pesos na interface e o sistema converte para o canônico ao gravar, guardando a cotação usada.

**`item_option_groups`** — `id`, `item_id`, `name` ("Tamanho", "Adicionais"), `min_select`, `max_select`, `is_required`.

**`item_options`** — `id`, `group_id`, `name`, `price_delta_brl`, `is_available`.

### 6.3 Endereços e geografia

**`addresses`** — `id`, `profile_id`, `label` ("casa", "mãe"), `street_id` (id estável do dataset OSM), `street_name` (desnormalizado, para histórico), `number`, `complement`, `between_streets` (texto, derivado do seletor de quadra), **`reference`** (texto livre — campo de primeira classe), `city`, `country`, `lat`, `lng`, `precision` (`gps` | `quadra` | `rua`), `is_default`.

**`zones`** — `id`, `city`, `name`, `polygon` (GeoJSON), `surcharge_brl`, `is_served`, `notes`.
Zona não servida bloqueia o pedido com mensagem explicativa editável.

### 6.4 Pedido

**`orders`**

- Identificação: `id`, `code` (curto e legível, para falar no telefone), `kind` (`food` | `courier` | `ride`)
- Partes: `client_id`, `merchant_id` (nulo em `courier` e `ride`), `courier_id` (nulo até aceite), `fleet_id` (copiado de `couriers.fleet_id` no momento do aceite; permanece nulo quando o motoboy é autônomo, e nesse caso a taxa de entrega é integralmente dele)
- Geografia: `pickup_address` (jsonb congelado), `dropoff_address` (jsonb congelado), `distance_m`, `route_source` (`osrm` | `haversine`), `crosses_border` (booleano)
- Status: `status`, `status_updated_at`
- **Dinheiro congelado:** `pricing_rule_id`, `pricing_breakdown` (jsonb: base, km incluso, km excedente, valor por km, sobretaxa de zona, adicional noturno, taxa de travessia, subtotal de itens, comissão, total), `total_brl`, `fx_rate_id`, `fx_rate_used`, `currency_charged`, `total_charged`, `payment_method` (`dinheiro_brl` | `dinheiro_uyu` | `pix`), `change_for` (troco para quanto)
- Tempos: `created_at`, `accepted_at`, `prepared_at`, `picked_up_at`, `delivered_at`, `cancelled_at`, `cancel_reason`, `cancelled_by`
- Extras: `client_notes`, `eta_minutes`, `rating`, `rating_comment`

**`order_items`** — `order_id`, `item_id` (referência histórica), `name_snapshot`, `unit_price_brl_snapshot`, `qty`, `options_snapshot` (jsonb), `line_total_brl`.
Mudança futura no cardápio não altera pedido passado.

**`order_events`** — `order_id`, `from_status`, `to_status`, `actor_id`, `actor_role`, `note`, `created_at`.
Serve como trilha de auditoria **e** como fonte da timeline de rastreio exibida ao cliente.

**`courier_positions`** — `courier_id`, `order_id`, `lat`, `lng`, `heading`, `accuracy_m`, `recorded_at`. Tabela de escrita intensa, com retenção curta (expurgo após 7 dias); a última posição também é espelhada no pedido.

### 6.5 Preço, câmbio e configuração

**`pricing_rules`** — `id`, `city`, `kind`, `base_fare_brl`, `included_km`, `per_km_brl`, `min_fare_brl`, `night_surcharge_brl`, `night_from`, `night_to`, `cross_border_fee_brl`, `passenger_cross_border_fee_brl`, `service_fee_pct`, `valid_from`, `valid_to`, `created_by`.
Regras são **versionadas por data**, nunca editadas no lugar. Reajuste cria nova versão.

**Valores padrão iniciais (editáveis no admin):**

- `base_fare_brl` = 10,00 · `included_km` = 2,0 · `per_km_brl` = 2,50 · `min_fare_brl` = 10,00
- `night_surcharge_brl` = 3,00 entre 23h e 00h (única hora noturna dentro do expediente de 06:00–00:00)
- `cross_border_fee_brl` = 8,00 · `passenger_cross_border_fee_brl` = 12,00

Base da estimativa: referências públicas de mercado — mínimo de cerca de R$ 12,00 até 1 km e R$ 2,00/km excedente (Gollog), custo por km entre R$ 2,00 e R$ 5,00 (Melhor Envio), taxa de R$ 14,00 a R$ 15,00 em raio de 4 km (Vem Pro Juca). **Não existe tabela pública de tele-entrega de Quaraí**; o raio urbano da cidade é de aproximadamente 2 km, o que justifica a base menor. Estes números são ponto de partida e devem ser calibrados com o preço que os motoboys locais praticam hoje.

**`fx_rates`** — `id`, `pair` (`BRL/UYU`), `rate`, `source` (`fxfeed` | `manual`), `spread_pct`, `is_manual_override`, `fetched_at`, `valid_for_date`.
Atualização diária por cron. Se a API falhar, usa a última gravada e a interface exibe "cotação de DD/MM". Admin pode travar taxa manual e definir spread. Referência de ordem de grandeza observada: cerca de 7,7 a 8,0 UYU por BRL.

**`settings`** — `key`, `value` (jsonb), `is_public`, `updated_by`, `updated_at`. Guarda textos da landing, banners, teto global de raio de atendimento, **`service_hours` por cidade e por tipo de serviço**, URL do provedor de tiles, avisos, telefones de suporte.

**Horário de serviço, não horário da ponte.** A ponte Quaraí–Artigas é **aberta 24 horas e não tem horário de funcionamento**. O limite real é regra do município sobre o serviço: **das 06:00 às 00:00**, confirmado pelo dono do negócio, para tele de lanches, encomenda e passageiro. Portanto a travessia nunca é bloqueada por horário, e o que bloqueia pedido é `service_hours`, guardado por cidade e por `kind` — as duas cidades são municípios de países diferentes e podem divergir, mesmo começando iguais.

Consequência sobre o adicional noturno: com expediente de 06:00 às 00:00, a janela da spec (23:00–05:00) descreve cinco horas que **não podem existir**. A janela armazenada passa a ser **23:00–00:00**, que é a única hora noturna real, mantendo o valor de R$ 3,00 para o dono ajustar. Isso é higiene de dado, não mudança de regra: o comportamento efetivo é idêntico, porque fora do expediente não há pedido.

**`audit_log`** — `actor_id`, `actor_role`, `table_name`, `record_id`, `action`, `before` (jsonb), `after` (jsonb), `created_at`.

**`status_transitions`** — `kind`, `from_status`, `to_status`, `allowed_role`. Tabela de dados, não código.

---

## 7. Motor de preço

Função Postgres `quote_order(kind, pickup, dropoff, merchant_id, items, at_time)` retorna jsonb com o detalhamento completo e os ids de `pricing_rule` e `fx_rate` usados.

Sequência:

1. Resolver a cidade de origem e selecionar a `pricing_rule` vigente para (`city`, `kind`).
2. Calcular distância: OSRM público; em falha, haversine × 1,35 e marcar `route_source`.
3. Taxa de entrega = `base_fare` + max(0, distância_km − `included_km`) × `per_km`, com piso em `min_fare`.
4. Somar sobretaxa de zona, adicional noturno e taxa de travessia quando `crosses_border`.
5. Em `food`, somar subtotal dos itens com opções e calcular comissão do merchant.
6. Converter para a moeda de cobrança com a `fx_rate` do dia mais o spread; arredondar pesos para múltiplo de 1.
7. Devolver o detalhamento linha por linha, para a interface mostrar de onde vem cada centavo.

Na criação do pedido, a Server Action chama `quote_order` novamente e compara com o valor que o cliente viu. Divergência acima de um centavo rejeita e registra. O jsonb retornado é gravado em `pricing_breakdown`.

---

## 8. Máquina de estados

Uma máquina, três subconjuntos. Transições validadas contra `status_transitions`.

- **`food`:** `criado` → `aguardando_loja` → `em_preparo` → `pronto` → `coletado` → `em_rota` → `entregue`
- **`courier`:** `criado` → `aguardando_motoboy` → `aceito` → `coletado` → `entregue`
- **`ride`:** `criado` → `aceito` → `motoboy_chegou` → `em_viagem` → `finalizado`

Quem move o quê:

- `merchant`: `em_preparo`, `pronto`, e `cancelado` com motivo
- `courier`: `aceito`, `coletado`, `em_rota`, `motoboy_chegou`, `em_viagem`, `entregue`, `finalizado`
- `client`: apenas `cancelado`, e somente antes de `em_preparo`
- `admin`: qualquer transição, sempre com motivo e registro

Todo cancelamento grava `cancel_reason` e `cancelled_by`.

---

## 9. Endereços: pipeline e interface

### 9.1 Extração

Script de build consulta o Overpass e grava os JSON por cidade.

**Restrições descobertas e verificadas em 09/11/2026:**

- O Overpass responde a **GET com `User-Agent` definido**. POST retorna `406 Not Acceptable`, e consultas por `area[name=...]` caíram em `502 at capacity`. A extração usa **GET com bounding box**, com repetição em recuo exponencial.
- Dados reais medidos na bbox `-30.44,-56.54,-30.32,-56.38`: **1.136 vias com nome**, e **507 nomes únicos** na bbox.
- Após classificação por ponto-em-polígono contra o limite municipal: **209 ruas em Quaraí e 262 em Artigas**, 470 nomes únicos na união. As 37 restantes caem fora dos dois polígonos (estradas rurais e barrios afastados, como `Ruta 30` e `Yerbal`).
- **Apenas um nome existe nos dois lados da fronteira: `Puente de la Concordia`**, a ponte — gravada uma vez como `BR` e uma vez como `UY`.

  Correção registrada: uma versão anterior desta spec afirmava que 14 nomes se repetiam nos dois lados, entre eles `18 de Julio`. Isso era artefato de uma divisão aproximada por latitude: **Quaraí fica a leste de Artigas, nas mesmas latitudes**, então o corte por latitude misturou as duas cidades. Nos dados reais, `18 de Julio`, `18 de Mayo`, `Aparicio Saravia`, `Amaro Ferreira Ramos` e `Brigadier General Diego Lamas` existem **só em Artigas**, e `Avenida Simões Lopes Neto` **só em Quaraí**.

- **Cidade e país continuam obrigatórios** em toda sugestão de endereço e em todo pedido, por três razões que não dependem de nomes repetidos: a busca varre as duas cidades ao mesmo tempo, então a lista de resultados mistura países e precisa rotular cada um; a moeda de cobrança decorre do país; e a taxa de travessia decorre de origem e destino estarem em países diferentes.

A classificação por cidade usa ponto-em-polígono contra o limite municipal (baixado uma vez por id de relação do OSM e versionado), nunca corte por latitude.

Saída por cidade: `{ id, name, name_normalized, city, country, segments: [[lat,lng]...], intersections: [{street_id, lat, lng}] }`, mais uma lista de **referências** extraída de `amenity`/`shop` do OSM (postos, praças, escolas, igrejas, hospital, a ponte).

### 9.2 Montagem do endereço — três camadas de precisão

Numeração predial é incompleta no OSM em cidade pequena, e muita casa não tem número na parede. O app não finge precisão que não tem:

1. **Rua + quadra** — depois da rua, o cliente escolhe entre quais esquinas, derivadas de `intersections`. Grava `precision = quadra`.
2. **Pino no mapa** — opcional, arrastável, pré-posicionado na quadra. Ou "usar minha localização" (Geolocation). Grava `precision = gps`.
3. **Referência em texto livre** — campo de primeira classe, exibido **em destaque na tela do motoboy, acima do número**.

Busca: fuzzy sobre `name_normalized` (sem acento, minúsculo, ignorando prefixo "Rua/Avenida/Calle"), três letras bastam, cada sugestão com a bandeira do país.

Endereços são salvos com apelido, então o segundo pedido é um toque.

### 9.3 Mapa e rastreio

- **Leaflet** com tiles OSM. A política de uso do OSM não permite tráfego pesado; a URL do provedor é uma `setting`, trocável por Carto/Stadia ou auto-hospedagem sem alterar código.
- **Transmissão de posição:** `watchPosition` no navegador do motoboy, enviada a cada cerca de 10 s **ou** 30 m de deslocamento, o que ocorrer primeiro — poupa bateria e dados. Canal Realtime do Supabase por pedido; última posição espelhada no pedido.
- **No mapa do cliente a moto interpola suavemente** entre pontos, em vez de teleportar.
- **Falha de tiles** não bloqueia nada: cai para o endereço em texto e a timeline.

### 9.4 Fronteira

Pedido com `crosses_border = true`: taxa própria, aviso de documento para passageiro, ETA com folga de aduana, e oferta restrita a motoboys com `accepts_cross_border`. A ponte é aberta 24 horas, então **a travessia nunca é recusada por horário**. O que limita é `service_hours` (regra do município sobre o serviço), aplicado a todo pedido, cruzado ou não.

---

## 10. Sistema visual

### 10.1 Conceito

A marca nasce do que as duas cidades compartilham — **o sol, o campo seco e a ponte** — e não de simbolismo nacional, que obrigaria o app a escolher um lado.

O elemento gráfico central é **a malha real de ruas das duas cidades**, vinda do mesmo dataset que alimenta a busca: duas tramas urbanas separadas pelo rio e costuradas pela ponte. Não é ilustração genérica de delivery — é o mapa da cidade do usuário, e nenhum concorrente teria isso.

### 10.2 Tokens

**Dark-first por razão funcional**, não por moda: motoboy trabalha de noite com o celular no suporte. Tema claro disponível.

- Fundo `#0B0F0D` · superfícies em verde-grafite
- **Sol `#F2A516`** — acento primário: preço, ação principal, motoboy no mapa
- **Brasa `#D9452B`** — urgência: cancelar, atrasado, ao vivo
- **Rio `#2E7D8C`** — informação, fronteira, o que é uruguaio
- **Campo `#1F4D3A`** — apoio
- Sem roxo de startup

**Tipografia:** display condensado e pesado para manchete (peso de cartaz, sem virar faroeste); sans neutra e muito legível na interface; **números tabulares obrigatórios em todo preço**, porque R$ e $U lado a lado com largura variável desalinham, e preço desalinhado parece golpe.

**Motivo gráfico:** a **guarda pampa**, padrão geométrico escalonado da tradição têxtil criolla, comum aos dois lados da fronteira. Usada em divisor de seção, barra de progresso, borda de card e estado vazio. Regional sem fantasia: nenhum chapéu, nenhuma bombacha, nenhuma cuia desenhada.

### 10.3 Movimento

**Remotion** (vídeo é a ferramenta certa): hero data-driven que desenha a malha de Quaraí linha por linha, revela Artigas, conecta a ponte e percorre uma rota real enquanto o sol sobe; onboarding em tela cheia; vídeos verticais de divulgação com texto editável no painel — que é o que traz cliente em cidade pequena, via status de WhatsApp. Saída `.webm` e `.mp4`, poster estático, carregamento preguiçoso, só o poster em conexão lenta.

**GSAP e SVG** (precisa de transparência, dado real e resposta imediata): radar de "procurando motoboy" varrendo a malha, timeline do pedido, moto deslizando no mapa, recálculo de preço com número girando, bottom sheet com mola, skeleton virando conteúdo.

**Landing:** GSAP + Lenis, seções fixadas, manchete entrando palavra por palavra, malha se desenhando no scroll.

`prefers-reduced-motion` desliga o decorativo sem quebrar o funcional.

### 10.4 Restrição de desempenho (não negociável)

Público em Android de entrada com dados contados. **Sem WebGL, sem three.js, sem parallax de muitas camadas.** Apenas `transform` e `opacity`. Dataset carregado sob demanda. O app precisa abrir rápido num aparelho modesto — é isso que ganha do iFood ali, não efeito visual.

---

## 11. Internacionalização

- Idioma: `pt-BR` e `es-UY`, detectado e trocável, **independente da moeda**.
- Moeda de exibição escolhida pelo usuário; moeda canônica interna sempre BRL.
- Formatação por locale: separador decimal, símbolo, posição.
- Telefones nos dois formatos (+55 e +598).
- Pesos arredondados para múltiplo de 1 na exibição.

---

## 12. Testes

- **Unitário:** motor de preço (cada parcela, pisos, noturno, travessia), conversão de moeda com spread e arredondamento, busca fuzzy de rua, haversine e fator de malha.
- **Políticas RLS:** para cada tabela, um teste por papel confirmando leitura e escrita permitidas **e negadas**. Em particular: `fleet` não lê faturamento de merchant; `courier` não lê pedido de outro; `client` não lê pedido alheio.
- **Máquina de estados:** toda transição permitida passa, toda proibida falha, por papel e por `kind`.
- **Integração:** pedido ponta a ponta nos três `kind`, incluindo cruzando a fronteira e com OSRM indisponível.
- **Degradação:** FX fora do ar, tiles fora do ar, GPS negado.
- **Dispositivo real:** o fluxo do cliente testado em Android de entrada antes de considerar a fatia concluída.

---

## 13. Riscos conhecidos

| Risco | Mitigação |
|---|---|
| Overpass instável e com restrição de método | Extração em build, não em runtime; GET com User-Agent, recuo exponencial, dataset versionado no repositório |
| Política de tiles do OSM proíbe tráfego pesado | URL do provedor como `setting`; troca sem deploy |
| Nomes de rua duplicados entre países | Cidade e país obrigatórios em toda sugestão e no pedido |
| OSRM público pode cair ou limitar | Fallback haversine × 1,35, marcado em `route_source` |
| Preços padrão não calibrados com a realidade local | Tudo editável no admin; calibrar com motoboys de Quaraí antes de abrir |
| Comerciante informal não quer painel | Fatia 1 permite o admin semear o cardápio; painel do merchant é a Fatia 2 |
| Posição em tempo real consome bateria e dados | Throttle por tempo e distância, transmissão só durante pedido ativo |
| Regra de câmbio pode gerar prejuízo | Spread configurável, override manual, cotação congelada no pedido |

---

## 14. Fora de escopo da Fatia 1

Gateway de pagamento e repasse automático · escrita de cardápio pelo merchant · app nativo em loja · notificação push (a Fatia 1 usa estado na tela e WhatsApp) · cupom e promoção · programa de fidelidade · chat entre cliente e motoboy · nota fiscal e obrigação tributária · despacho automático por proximidade (a Fatia 1 usa fila aberta por cidade).

---

## 15. Referências de preço consultadas

- Gollog — mínimo de cerca de R$ 12,00 até 1 km, R$ 2,00/km excedente: https://www.gollog.com.br/en/solucoes-gollog/gollog-urgente
- Melhor Envio — custo por km entre R$ 2,00 e R$ 5,00: https://melhorenvio.com.br/blog/frete-e-logistica/moto-entrega/
- Vem Pro Juca — taxa de R$ 14,00 a R$ 15,00 em raio de 4 km: https://vemprojuca.com/blog/quanto-cobrar-de-entrega/
- FXFeed BRL/UYU, plano gratuito de 5.000 requisições por mês: https://fxfeed.io/currencies/pairs/brl-uyu
