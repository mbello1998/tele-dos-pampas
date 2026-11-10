# Tele dos Pampas — Fatia 1 (Fundação + Cliente Pede) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um cliente em Quaraí ou Artigas abre o site, encontra o próprio endereço, monta um pedido de um trailer ou restaurante, vê o preço nas duas moedas, confirma, e acompanha o pedido até a entrega — com o admin despachando manualmente.

**Architecture:** Next.js 15 App Router lê por Server Components e escreve por Server Actions. Preço e permissão vivem no Postgres (função `quote_order` + RLS por papel), nunca no navegador. Endereços vêm de um dataset OSM estático gerado em build, não de API em runtime.

**Tech Stack:** Next.js 15 (App Router), React 19, TypeScript estrito, Tailwind CSS 4, Supabase (Postgres + Auth OTP + Realtime + Storage), Leaflet 1.9, GSAP 3 + Lenis, Vitest (unitário e RLS), Playwright (e2e), Netlify (deploy + cron).

**Spec:** `docs/superpowers/specs/2026-11-09-tele-dos-pampas-design.md`

## Global Constraints

- Moeda canônica interna é **sempre BRL**; UYU é derivada. Todo valor monetário é `numeric(10,2)` no banco, nunca float.
- **Nenhum preço vindo do cliente é confiado.** Toda escrita de pedido recalcula via `quote_order` e rejeita divergência maior que R$ 0,01.
- **RLS habilitada em todas as tabelas**, sem exceção. Tabela sem policy é bug bloqueante.
- Papel do usuário é lido de `profiles.role` por função `security definer`, **nunca** de claim de JWT.
- `pricing_rules` e `fx_rates` são **versionadas por data**, nunca editadas no lugar.
- Toda sugestão de endereço e todo endereço gravado carregam **cidade e país** obrigatórios (14 nomes de rua existem nos dois lados da fronteira).
- Valores padrão de preço: base R$ 10,00 · 2,0 km inclusos · R$ 2,50/km · mínimo R$ 10,00 · noturno R$ 3,00 entre 23h e 05h · travessia R$ 8,00 · travessia com passageiro R$ 12,00.
- Fallback de distância sem OSRM: haversine × **1,35**, marcado em `route_source`.
- Posição do motoboy transmitida a cada **10 s ou 30 m**, o que vier primeiro, e só durante pedido ativo.
- Animação apenas em `transform` e `opacity`. **Sem WebGL, sem three.js.** `prefers-reduced-motion` desliga o decorativo.
- Todo preço renderizado usa **números tabulares** (`font-variant-numeric: tabular-nums`).
- Idioma (`pt-BR` | `es-UY`) e moeda de exibição (`BRL` | `UYU`) são **independentes**.
- Tokens de cor: fundo `#0B0F0D`, sol `#F2A516`, brasa `#D9452B`, rio `#2E7D8C`, campo `#1F4D3A`.

## Review Focus

Classes de entrada que a spec implica, que nenhum fluxo principal exercita, e que machucariam um usuário real. Cada linha tem o teste adicionado na tarefa dona do código.

1. **Dois motoboys aceitam o mesmo pedido ao mesmo tempo** — o aceite tem que ser atômico; o segundo recebe erro claro, não um pedido roubado. (Tarefa 13)
2. **Tabela `fx_rates` vazia no primeiro dia, ou API de câmbio fora do ar** — o app continua aceitando pedido usando a taxa manual padrão, com aviso de data, em vez de estourar. (Tarefa 7)
3. **Item indisponível ou loja fechada entre montar o carrinho e confirmar** — a confirmação recusa com mensagem que diz qual item, e não grava pedido parcial. (Tarefa 11)
4. **GPS negado, impreciso ou ausente** — endereço cai para `precision = quadra` e o rastreio mostra a timeline sem mapa, sem travar o pedido. (Tarefas 9 e 12)
5. **Origem igual ao destino, ou destino fora do raio atendido** — distância zero aplica o mínimo; fora do raio bloqueia com a mensagem editável da zona, nunca cobra valor absurdo. (Tarefa 6)

---

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `scripts/osm/fetch-streets.ts` | Consulta Overpass por bbox com recuo exponencial |
| `scripts/osm/build-dataset.ts` | Classifica por município, extrai cruzamentos e referências, grava JSON |
| `src/lib/geo/normalize.ts` | Normalização de nome de rua |
| `src/lib/geo/search.ts` | Busca fuzzy no dataset |
| `src/lib/geo/distance.ts` | Haversine e fator de malha |
| `src/lib/geo/osrm.ts` | Cliente OSRM com fallback |
| `src/lib/money/format.ts` | Formatação por locale e moeda |
| `src/lib/fx/rate.ts` | Leitura e conversão de câmbio |
| `supabase/migrations/*.sql` | Schema, enums, RLS, `quote_order`, transições |
| `supabase/seed.sql` | `status_transitions`, `pricing_rules`, `settings`, merchants de exemplo |
| `src/app/(cliente)/**` | Rotas do cliente |
| `src/app/admin/despacho/**` | Console de despacho mínimo |
| `src/components/address/**` | Seletor de endereço em 3 camadas |
| `src/components/order/**` | Carrinho, resumo de preço, timeline, mapa |
| `src/components/motion/**` | Primitivas GSAP reutilizáveis |
| `src/actions/orders.ts` | Server Actions de pedido |
| `tests/**` | Vitest (unitário + RLS) e Playwright (e2e) |

---

## Task 1: Scaffold e tokens visuais

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/styles/tokens.css`, `vitest.config.ts`, `.env.example`, `netlify.toml`
- Test: `tests/unit/tokens.test.ts`

**Interfaces:**
- Consumes: nada
- Produces: projeto Next 15 executável; classes utilitárias Tailwind `bg-noite`, `text-sol`, `text-brasa`, `text-rio`, `bg-campo`; `npm test` rodando Vitest

- [ ] **Step 1: Escrever o teste que falha**

```ts
// tests/unit/tokens.test.ts
import tokens from '../../src/styles/tokens.css?raw'
test('tokens de cor da spec estão definidos', () => {
  for (const hex of ['#0B0F0D', '#F2A516', '#D9452B', '#2E7D8C', '#1F4D3A']) {
    expect(tokens).toContain(hex)
  }
})
test('preço usa números tabulares', () => {
  expect(tokens).toContain('tabular-nums')
})
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npm test -- tests/unit/tokens.test.ts`
Expected: FAIL — arquivo `tokens.css` não existe

- [ ] **Step 3: Criar o projeto e os tokens**

`npx create-next-app@latest` com TypeScript, Tailwind, App Router, sem `src/app/api` de exemplo. Em `tokens.css`, declarar as cinco cores como custom properties em `:root` e uma classe `.preco { font-variant-numeric: tabular-nums; }`. Registrar as cores em `tailwind.config.ts` com os nomes `noite`, `sol`, `brasa`, `rio`, `campo`. Tema escuro é o padrão em `<html>`.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test && npm run build`
Expected: teste PASS, build sem erro

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: scaffold Next 15 com tokens visuais pampa"
```

---

## Task 2: Extração do dataset OSM

**Files:**
- Create: `scripts/osm/fetch-streets.ts`, `scripts/osm/build-dataset.ts`, `src/lib/geo/types.ts`
- Test: `tests/unit/osm-build.test.ts`, `tests/fixtures/overpass-sample.json`

**Interfaces:**
- Consumes: nada
- Produces: `fetchStreets(bbox: BBox): Promise<OverpassWay[]>` · `buildDataset(ways: OverpassWay[], boundary: Polygon, city: City): StreetDataset` · arquivos `public/data/quarai.json` e `public/data/artigas.json`
- Tipos definidos em `src/lib/geo/types.ts`, usados por todas as tarefas seguintes:
  - `type LatLng = { lat: number; lng: number }`
  - `type BBox = { south: number; west: number; north: number; east: number }`
  - `type City = 'quarai' | 'artigas'` · `type Country = 'BR' | 'UY'`
  - `type Polygon = LatLng[]`
  - `type Intersection = { streetId: string; streetName: string; at: LatLng }`
  - `type Street = { id: string; name: string; nameNormalized: string; city: City; country: Country; segments: LatLng[][]; intersections: Intersection[] }`
  - `type Reference = { id: string; name: string; kind: string; at: LatLng; city: City }`
  - `type StreetDataset = { city: City; country: Country; streets: Street[]; references: Reference[] }`

- [ ] **Step 1: Escrever os testes que falham**

```ts
// tests/unit/osm-build.test.ts
test('classifica rua pelo polígono do município, não por latitude')
test('gera id estável: mesmo input produz mesmo id')
test('extrai cruzamentos onde duas ruas compartilham coordenada')
test('agrupa segmentos da mesma rua sob um único registro')
test('descarta via sem nome')
```
Cada teste usa `tests/fixtures/overpass-sample.json`, um recorte real de ~20 vias com os dois lados da fronteira, incluindo `18 de Julio` duplicada.

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npm test -- tests/unit/osm-build.test.ts`
Expected: FAIL — `buildDataset` não existe

- [ ] **Step 3: Implementar `fetchStreets` e `buildDataset`**

`fetchStreets` usa **GET** com `User-Agent: tele-dos-pampas-build/1.0` e `--data-urlencode`-equivalente em query string; POST retorna 406 e `area[name=...]` retorna 502, então a consulta é por bbox: `way(BBOX)["highway"]["name"];out tags geom;`. Recuo exponencial de 2 s, 4 s, 8 s, 16 s, 32 s em 429/502/504, três mirrors em ordem. `buildDataset` classifica cada via por ponto-em-polígono contra o limite municipal, deriva `nameNormalized` via Tarefa 3, e calcula cruzamentos por coordenada compartilhada entre vias de nomes diferentes.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test -- tests/unit/osm-build.test.ts`
Expected: PASS

- [ ] **Step 5: Gerar o dataset real e conferir as contagens**

Run: `npx tsx scripts/osm/build-dataset.ts`
Expected: `quarai.json` e `artigas.json` criados; total de nomes únicos próximo de 521, com aproximadamente 215 em Quaraí e 306 em Artigas; `18 de Julio` presente nos dois arquivos com `country` diferente

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: extração do dataset de ruas de Quaraí e Artigas do OSM"
```

---

## Task 3: Normalização e busca de rua

**Files:**
- Create: `src/lib/geo/normalize.ts`, `src/lib/geo/search.ts`
- Test: `tests/unit/street-search.test.ts`

**Interfaces:**
- Consumes: tipo `Street` da Tarefa 2
- Produces: `normalizeStreetName(name: string): string` · `searchStreets(query: string, datasets: StreetDataset[], limit?: number): StreetHit[]` onde `StreetHit = Street & { score: number }`

- [ ] **Step 1: Escrever os testes que falham**

```ts
test('"sao joao" encontra "Avenida São João Batista do Quaraí"')
test('"18 de julio" retorna DOIS resultados, um BR e um UY')
test('ignora prefixo: "bento" encontra "Rua Bento Gonçalves"')
test('três letras já retornam resultado')
test('tolera um erro de digitação: "gonzalves" encontra "Gonçalves"')
test('ordena por score, prefixo exato primeiro')
test('query vazia retorna lista vazia, não o dataset inteiro')
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npm test -- tests/unit/street-search.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementar normalização e busca**

`normalizeStreetName` remove diacríticos via `normalize('NFD')`, baixa para minúsculas, e remove os prefixos `rua`, `avenida`, `av`, `travessa`, `beco`, `estrada`, `calle`, `camino`, `pasaje`. A busca combina prefixo exato (score alto) com distância de edição limitada a 2 sobre a forma normalizada. Nenhuma dependência externa.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test -- tests/unit/street-search.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: busca fuzzy de rua com desambiguação por país"
```

---

## Task 4: Schema do banco

**Files:**
- Create: `supabase/migrations/0001_enums.sql`, `0002_pessoas.sql`, `0003_catalogo.sql`, `0004_enderecos.sql`, `0005_pedidos.sql`, `0006_preco_cambio_config.sql`, `supabase/seed.sql`
- Test: `tests/db/schema.test.ts`

**Interfaces:**
- Consumes: nada
- Produces: todas as tabelas da seção 6 da spec; enums `user_role`, `order_kind`, `order_status`, `payment_method`, `merchant_kind`, `address_precision`, `route_source`; seeds de `status_transitions`, `pricing_rules` padrão, `settings` e dois merchants de exemplo (um trailer em Quaraí, um restaurante em Artigas)

- [ ] **Step 1: Escrever os testes que falham**

```ts
test('todas as tabelas da spec existem')
test('todo valor monetário é numeric, nenhum é float ou double')
test('RLS está habilitada em TODAS as tabelas públicas') // constraint global
test('seed carrega as 7 transições de food, 5 de courier e 5 de ride')
test('pricing_rules padrão tem base 10.00, included_km 2.0, per_km 2.50, min 10.00')
test('pricing_rules não permite duas versões vigentes para a mesma cidade e kind')
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npx supabase start && npm test -- tests/db/schema.test.ts`
Expected: FAIL — relação não existe

- [ ] **Step 3: Escrever as migrations**

Uma migration por grupo da seção 6. Colunas e tipos exatamente como a spec lista. `orders.code` é texto curto único gerado por default. Exclusão de vigência sobreposta em `pricing_rules` via constraint de exclusão sobre `(city, kind, daterange(valid_from, valid_to))`. `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` em toda tabela, mesmo antes de existirem policies.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test -- tests/db/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: schema do banco com seeds de transições e preço padrão"
```

---

## Task 5: RLS e papéis

**Files:**
- Create: `supabase/migrations/0007_rls_helpers.sql`, `0008_rls_policies.sql`
- Test: `tests/db/rls.test.ts`

**Interfaces:**
- Consumes: schema da Tarefa 4
- Produces: `current_role() returns user_role` (`security definer`, lê `profiles` por `auth.uid()`) · `is_admin() returns boolean` · policies por tabela e papel

- [ ] **Step 1: Escrever os testes que falham**

Um bloco por papel, cada um com cliente Supabase autenticado como aquele papel. Negações são tão obrigatórias quanto permissões:

```ts
test('client lê o próprio pedido')
test('client NÃO lê pedido de outro client')
test('client NÃO altera total_brl do próprio pedido')
test('courier lê pedidos aguardando na cidade onde está habilitado')
test('courier NÃO lê pedido atribuído a outro courier')
test('merchant lê apenas pedidos da própria loja')
test('merchant NÃO lê catalog_items de outro merchant')
test('fleet lê pedidos atendidos pela própria frota')
test('fleet NÃO lê faturamento nem catalog_items de merchant')     // isolamento financeiro
test('merchant NÃO lê couriers nem repasse de frota')              // isolamento financeiro
test('anon lê settings com is_public true e NÃO as demais')
test('anon NÃO lê profiles')
test('ninguém além de admin escreve em pricing_rules ou fx_rates')
test('papel vem de profiles, não de JWT: claim role forjado é ignorado')
test('escrita de admin em pricing_rules grava audit_log com before e after')
test('escrita de merchant em catalog_items grava audit_log com ator e papel')
test('audit_log não é alterável nem apagável por nenhum papel, inclusive admin')
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npm test -- tests/db/rls.test.ts`
Expected: FAIL — sem policy, toda leitura retorna vazio e os testes de permissão falham

- [ ] **Step 3: Implementar helpers e policies**

`current_role()` é `security definer` com `search_path` fixo, lendo `profiles.role` por `auth.uid()`. Policies por tabela, uma por operação e papel. `orders` tem policy de `UPDATE` que não permite ao `client` tocar colunas de dinheiro — restrição por coluna via policy de update combinada com trigger que rejeita alteração de `total_brl`, `pricing_breakdown`, `fx_rate_used` por papel diferente de `admin`.

Auditoria: um trigger genérico `audit_write()` em `AFTER INSERT OR UPDATE OR DELETE` sobre `pricing_rules`, `fx_rates`, `settings`, `merchants`, `catalog_items`, `catalog_categories`, `couriers`, `zones` e `profiles`, gravando ator, papel, `before` e `after` em `audit_log`. `audit_log` recebe policy que permite apenas `INSERT` pelo trigger e `SELECT` por `admin` — nenhum papel pode alterar ou apagar.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test -- tests/db/rls.test.ts`
Expected: PASS, incluindo todas as negações

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: RLS com cinco papéis e isolamento financeiro entre merchant e fleet"
```

---

## Task 6: Distância e motor de preço

**Files:**
- Create: `src/lib/geo/distance.ts`, `src/lib/geo/osrm.ts`, `src/lib/pricing/types.ts`, `supabase/migrations/0009_quote_order.sql`
- Test: `tests/unit/distance.test.ts`, `tests/db/quote-order.test.ts`

**Interfaces:**
- Consumes: `LatLng` (Tarefa 2), `pricing_rules` e `zones` (Tarefa 4)
- Produces: `haversineMeters(a: LatLng, b: LatLng): number` · `routeDistance(a: LatLng, b: LatLng): Promise<{ meters: number; source: RouteSource }>` · função SQL `quote_order(p_kind, p_pickup jsonb, p_dropoff jsonb, p_merchant uuid, p_items jsonb, p_at timestamptz) returns jsonb`
- Tipo `Quote` em `src/lib/pricing/types.ts`, que espelha exatamente o jsonb devolvido por `quote_order` e é o contrato usado pelas Tarefas 10 e 11:
  - `type RouteSource = 'osrm' | 'haversine'`
  - `type QuoteLine = { key: string; labelKey: string; amountBrl: number }`
  - `type Quote = { breakdown: QuoteLine[]; totalBrl: number; pricingRuleId: string; distanceM: number; routeSource: RouteSource; crossesBorder: boolean; blocked: boolean; blockedReason: string | null }`

- [ ] **Step 1: Escrever os testes que falham**

```ts
// distance
test('haversine entre centro de Quaraí e centro de Artigas bate com o valor conhecido (±2%)')
test('OSRM indisponível cai para haversine × 1.35 e marca source haversine')
test('OSRM que responde em mais de 3 s é abortado e cai para o fallback')
```
```sql
-- quote_order
test('1,5 km dentro do incluso cobra exatamente a base 10.00')
test('4 km cobra 10.00 + 2 × 2.50 = 15.00')
test('resultado nunca fica abaixo do mínimo 10.00')
test('entre 23h e 05h soma 3.00')
test('pickup BR e dropoff UY soma travessia 8.00 e marca crosses_border')
test('kind ride cruzando a fronteira soma 12.00, não 8.00')
test('origem igual ao destino cobra o mínimo, não zero')              -- Review Focus 5
test('destino em zona com is_served false retorna blocked com a mensagem da zona')  -- Review Focus 5
test('sobretaxa de zona entra no breakdown como linha própria')
test('breakdown soma exatamente igual a total_brl')
test('usa a pricing_rule vigente na data, não a mais recente')
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npm test -- tests/unit/distance.test.ts tests/db/quote-order.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementar distância e `quote_order`**

`routeDistance` chama o OSRM público com timeout de 3 s e `AbortController`; qualquer erro ou timeout cai para haversine × 1,35. `quote_order` segue a sequência da seção 7 da spec, e devolve o breakdown linha por linha para a interface explicar cada centavo. Zona não servida retorna `blocked = true` com `blocked_reason` lido de `zones.notes`, sem lançar exceção.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test -- tests/unit/distance.test.ts tests/db/quote-order.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: motor de preço no Postgres com fallback de distância"
```

---

## Task 7: Câmbio BRL/UYU

**Files:**
- Create: `src/lib/fx/rate.ts`, `src/lib/money/format.ts`, `netlify/functions/update-fx.ts`
- Modify: `netlify.toml` (schedule diário)
- Test: `tests/unit/fx.test.ts`, `tests/db/fx.test.ts`

**Interfaces:**
- Consumes: `fx_rates` e `settings` da Tarefa 4
- Produces: `getEffectiveRate(date?: Date): Promise<{ rate: number; spreadPct: number; validForDate: string; isStale: boolean }>` · `convertBrlToUyu(brl: number, rate: number, spreadPct: number): number` (arredonda para múltiplo de 1) · `formatMoney(value: number, currency: 'BRL'|'UYU', locale: 'pt-BR'|'es-UY'): string`

- [ ] **Step 1: Escrever os testes que falham**

```ts
test('aplica spread: 10 BRL a 7.80 com 5% vira 82 UYU')
test('arredonda pesos para múltiplo de 1, sempre para cima')
test('override manual tem precedência sobre a taxa da API')
test('tabela fx_rates vazia usa a taxa padrão de settings e marca isStale')   // Review Focus 2
test('API fora do ar mantém a última taxa gravada e marca isStale')          // Review Focus 2
test('formatMoney pt-BR com BRL produz "R$ 15,00"')
test('formatMoney es-UY com UYU produz "$U 117"')
test('locale pt-BR com moeda UYU funciona: idioma e moeda são independentes')
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npm test -- tests/unit/fx.test.ts tests/db/fx.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementar leitura, conversão e o cron**

`getEffectiveRate` busca a linha de `valid_for_date` igual à data pedida; se não houver, usa a mais recente e marca `isStale`; se a tabela estiver vazia, usa `settings['fx.fallback_rate']` (padrão 7.80). A função Netlify consulta a FXFeed, grava uma nova linha, e **nunca** sobrescreve linha existente. Falha da API registra em log e termina com sucesso, sem alterar dados.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test -- tests/unit/fx.test.ts tests/db/fx.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: câmbio BRL/UYU com spread, override manual e degradação"
```

---

## Task 8: Auth, perfil e i18n

**Files:**
- Create: `src/lib/supabase/{client,server}.ts`, `src/app/entrar/page.tsx`, `src/app/onboarding/page.tsx`, `src/actions/profile.ts`, `src/lib/i18n/{index.ts,pt-BR.ts,es-UY.ts}`, `middleware.ts`
- Test: `tests/db/profile.test.ts`, `tests/e2e/auth.spec.ts`

**Interfaces:**
- Consumes: `profiles` e RLS das Tarefas 4 e 5
- Produces: `getSession()`, `requireRole(role: UserRole)` para Server Components · `updateProfile(input: ProfileInput)` Server Action · `t(key, locale)` · middleware que protege `/admin/*`

- [ ] **Step 1: Escrever os testes que falham**

```ts
test('novo usuário recebe profile com role client e status active')
test('usuário não pode alterar o próprio role')
test('locale e currency_pref são salvos independentemente')
test('middleware redireciona não-admin que acessa /admin')
test('as duas tabelas de tradução têm exatamente as mesmas chaves')
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npm test -- tests/db/profile.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementar auth e perfil**

OTP por telefone como método primário, e-mail como alternativa. Trigger `on_auth_user_created` insere `profiles` com `role = 'client'`. Trigger separado rejeita `UPDATE` de `role` quando `current_role() <> 'admin'`. Detecção de locale pelo header `Accept-Language`, com troca persistida no perfil e, para anônimo, em cookie.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test -- tests/db/profile.test.ts && npx playwright test tests/e2e/auth.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: auth OTP, perfis com papel protegido e i18n pt-BR/es-UY"
```

---

## Task 9: Seletor de endereço em três camadas

**Files:**
- Create: `src/components/address/{StreetPicker,BlockPicker,MapPin,ReferenceField,AddressForm}.tsx`, `src/components/map/LeafletMap.tsx`, `src/actions/addresses.ts`
- Test: `tests/unit/address-form.test.tsx`, `tests/e2e/address.spec.ts`

**Interfaces:**
- Consumes: `searchStreets` (Tarefa 3), dataset público (Tarefa 2), `addresses` + RLS (Tarefas 4 e 5)
- Produces: `saveAddress(input: AddressInput): Promise<Address>` · componente `<AddressForm onDone={(a: Address) => void} />` · `precision` derivada automaticamente

- [ ] **Step 1: Escrever os testes que falham**

```tsx
test('digitar 3 letras lista ruas com nome da cidade e bandeira do país')
test('escolher "18 de Julio" exige escolher a cidade antes de prosseguir')   // duplicata de fronteira
test('após escolher a rua, lista as esquinas vindas de intersections')
test('escolher quadra grava precision "quadra" e coordenada no meio do trecho')
test('usar minha localização grava precision "gps"')
test('GPS negado não bloqueia: continua em precision "quadra"')              // Review Focus 4
test('campo referência é obrigatório quando precision não é gps')
test('endereço salvo sem apelido recebe apelido padrão')
test('o mapa não é montado até o usuário pedir o pino')                      // orçamento de performance
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npm test -- tests/unit/address-form.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implementar os componentes**

Fluxo em três passos na ordem da seção 9.2 da spec. O dataset é carregado por `import()` dinâmico só quando o campo de rua recebe foco. Leaflet entra por `next/dynamic` com `ssr: false`, apenas quando o usuário abre o pino. A URL dos tiles vem de `settings['map.tile_url']`. O campo de referência tem rótulo explicando o porquê ("o motoboy lê isso para achar sua casa").

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test -- tests/unit/address-form.test.tsx && npx playwright test tests/e2e/address.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: seletor de endereço em três camadas de precisão"
```

---

## Task 10: Catálogo e carrinho

**Files:**
- Create: `src/app/(cliente)/lojas/page.tsx`, `src/app/(cliente)/lojas/[slug]/page.tsx`, `src/components/catalog/{MerchantCard,ItemCard,OptionGroup}.tsx`, `src/components/order/{Cart,PriceSummary}.tsx`, `src/lib/cart/store.ts`
- Test: `tests/unit/cart.test.ts`, `tests/e2e/catalog.spec.ts`

**Interfaces:**
- Consumes: catálogo (Tarefa 4), `formatMoney` e `getEffectiveRate` (Tarefa 7)
- Produces: `cartStore` com `addItem`, `removeItem`, `setOptions`, `subtotalBrl` · `<PriceSummary quote={Quote} />` exibindo o breakdown linha por linha

- [ ] **Step 1: Escrever os testes que falham**

```ts
test('subtotal soma preço base mais price_delta das opções escolhidas')
test('grupo de opção obrigatório impede adicionar ao carrinho')
test('max_select bloqueia a seleção excedente')
test('carrinho só aceita itens de um merchant por vez')
test('loja fechada por horário aparece como fechada e não deixa adicionar')
test('is_open_manual false fecha a loja mesmo dentro do horário')
test('PriceSummary mostra cada linha do breakdown e o total nas duas moedas')
test('preço exibido usa classe de números tabulares')
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npm test -- tests/unit/cart.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementar catálogo e carrinho**

Listagem e cardápio como Server Components. Carrinho em estado do cliente, persistido em `sessionStorage`. `PriceSummary` renderiza o jsonb de `quote_order` sem recalcular nada — o cliente só exibe. Loja aberta segue a regra da spec: `approved` e `is_open_manual` e dentro de uma faixa de `merchant_hours`.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test -- tests/unit/cart.test.ts && npx playwright test tests/e2e/catalog.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: catálogo, carrinho e resumo de preço nas duas moedas"
```

---

## Task 11: Criação do pedido

**Files:**
- Create: `src/actions/orders.ts`, `src/app/(cliente)/pedido/novo/page.tsx`, `supabase/migrations/0010_create_order.sql`
- Test: `tests/db/create-order.test.ts`, `tests/e2e/checkout.spec.ts`

**Interfaces:**
- Consumes: `quote_order` (Tarefa 6), carrinho (Tarefa 10), endereços (Tarefa 9), câmbio (Tarefa 7)
- Produces: `createOrder(input: CreateOrderInput): Promise<{ code: string }>` · função SQL `create_order(...)` que cota, congela e insere pedido, itens e o primeiro `order_events` numa única transação

- [ ] **Step 1: Escrever os testes que falham**

```ts
test('pedido grava pricing_breakdown, pricing_rule_id, fx_rate_used e total congelados')
test('total enviado pelo cliente divergindo mais de 1 centavo é rejeitado e vai para audit_log')
test('alterar pricing_rules depois NÃO altera o total do pedido já criado')
test('order_items guarda name_snapshot e unit_price_brl_snapshot')
test('alterar o preço do item no cardápio depois NÃO altera o pedido existente')
test('item indisponível entre montar e confirmar rejeita e diz qual item')     // Review Focus 3
test('loja fechada no instante da confirmação rejeita o pedido')               // Review Focus 3
test('rejeição não deixa pedido parcial: nenhuma linha em orders nem order_items')  // Review Focus 3
test('kind courier e ride aceitam merchant_id nulo')
test('pedido em zona não servida é rejeitado com a mensagem da zona')
test('payment_method dinheiro_uyu exige change_for maior ou igual ao total cobrado')
test('primeiro order_events registra criado com actor_role client')
test('code gerado é único e legível ao telefone')
test('mais de 5 pedidos do mesmo cliente em 10 minutos é recusado por rate limit')
test('rate limit conta por profile_id, não por IP')
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npm test -- tests/db/create-order.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementar `create_order`**

Função SQL numa transação: aplica o rate limit (conta pedidos do `profile_id` nos últimos 10 minutos contra `settings['orders.rate_limit_per_10min']`, padrão 5), valida disponibilidade de cada item e se a loja está aberta, chama `quote_order`, compara com o total recebido, insere `orders` com o breakdown congelado, insere `order_items` com snapshots, insere o `order_events` inicial. Qualquer validação que falha dá `RAISE` e desfaz tudo. A Server Action traduz a exceção em mensagem no idioma do usuário.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test -- tests/db/create-order.test.ts && npx playwright test tests/e2e/checkout.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: criação de pedido com recálculo no servidor e dados congelados"
```

---

## Task 12: Rastreio em tempo real

**Files:**
- Create: `src/app/(cliente)/pedido/[code]/page.tsx`, `src/components/order/{StatusTimeline,CourierMap,SearchingRadar}.tsx`, `src/lib/realtime/position.ts`, `supabase/migrations/0011_positions_rls.sql`
- Test: `tests/db/position-privacy.test.ts`, `tests/unit/interpolate.test.ts`, `tests/e2e/tracking.spec.ts`

**Interfaces:**
- Consumes: `orders`, `order_events`, `courier_positions` (Tarefas 4 e 5)
- Produces: `subscribeToOrder(code: string, cb: (e: OrderUpdate) => void): () => void` · `publishPosition(orderId, pos)` com throttle de 10 s ou 30 m · `interpolatePosition(from, to, t): LatLng`

- [ ] **Step 1: Escrever os testes que falham**

```ts
test('cliente do pedido lê a posição do motoboy enquanto o pedido está ativo')
test('cliente NÃO lê a posição depois de o pedido ser entregue')
test('outro cliente NÃO lê a posição em nenhum momento')
test('fleet lê a posição dos motoboys da própria frota')
test('publishPosition descarta envio antes de 10 s e menos de 30 m')
test('publishPosition envia quando andou mais de 30 m mesmo antes dos 10 s')
test('interpolatePosition em t=0.5 retorna o ponto médio')
test('sem posição nenhuma, a página mostra a timeline e não quebra')      // Review Focus 4
test('falha de tiles mostra endereço em texto e mantém a timeline')       // Review Focus 4
test('timeline é construída a partir de order_events, em ordem')
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npm test -- tests/db/position-privacy.test.ts tests/unit/interpolate.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementar rastreio**

Policy de `courier_positions` que permite `SELECT` ao cliente apenas quando o pedido referenciado está em status ativo. Canal Realtime por `order.code`. O marcador da moto anima entre pontos com `requestAnimationFrame` e `transform`. `SearchingRadar` é SVG com GSAP varrendo a malha de ruas, sem vídeo.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test -- tests/db/position-privacy.test.ts tests/unit/interpolate.test.ts && npx playwright test tests/e2e/tracking.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: rastreio em tempo real com privacidade por pedido ativo"
```

---

## Task 13: Console de despacho do admin

**Files:**
- Create: `src/app/admin/despacho/page.tsx`, `src/components/admin/{OrderRow,TransitionButtons,CourierSelect}.tsx`, `src/actions/dispatch.ts`, `supabase/migrations/0012_transition_order.sql`
- Test: `tests/db/transition.test.ts`, `tests/e2e/dispatch.spec.ts`

**Interfaces:**
- Consumes: `status_transitions` (Tarefa 4), `orders` (Tarefa 11)
- Produces: função SQL `transition_order(p_order uuid, p_to order_status, p_note text) returns void` validando contra `status_transitions` e `current_role()` · `assignCourier(orderId, courierId)` Server Action

- [ ] **Step 1: Escrever os testes que falham**

```ts
test('transição listada em status_transitions para o papel é aceita')
test('transição não listada é rejeitada')
test('client tentando marcar entregue é rejeitado')
test('client cancela antes de em_preparo')
test('client NÃO cancela depois de em_preparo')
test('toda transição grava order_events com ator e papel')
test('cancelamento sem motivo é rejeitado')
test('atribuir motoboy copia fleet_id de couriers para o pedido')
test('motoboy autônomo deixa fleet_id nulo')
test('dois aceites simultâneos: o segundo falha e o pedido fica com um só courier')  // Review Focus 1
test('transição em pedido de kind ride usa o subconjunto de ride')
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npm test -- tests/db/transition.test.ts`
Expected: FAIL

- [ ] **Step 3: Implementar `transition_order` e o console**

A função trava a linha do pedido com `SELECT ... FOR UPDATE` antes de validar, o que torna o aceite atômico: o segundo aceite encontra `courier_id` já preenchido e recebe exceção. O console lista pedidos ativos e renderiza **apenas** os botões cujas transições existem em `status_transitions` para o papel atual — nada de botão que o banco vai recusar. Tela deliberadamente simples, sem animação.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test -- tests/db/transition.test.ts && npx playwright test tests/e2e/dispatch.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: console de despacho com transições atômicas validadas no banco"
```

---

## Task 14: Landing, movimento e orçamento de performance

**Files:**
- Create: `src/app/page.tsx`, `src/components/motion/{ScrollReveal,SplitHeadline,StreetGridDraw,GuardaPampaDivider}.tsx`, `src/lib/motion/lenis.ts`
- Test: `tests/unit/motion.test.tsx`, `tests/e2e/landing.spec.ts`, `tests/e2e/perf.spec.ts`

**Interfaces:**
- Consumes: dataset (Tarefa 2), `settings` públicas (Tarefa 4), tokens (Tarefa 1)
- Produces: primitivas de movimento reutilizáveis; landing com textos lidos de `settings`

- [ ] **Step 1: Escrever os testes que falham**

```tsx
test('prefers-reduced-motion desliga o movimento decorativo e mantém o conteúdo visível')
test('StreetGridDraw usa a malha real do dataset, não um SVG fixo')
test('as animações alteram apenas transform e opacity')
test('textos da landing vêm de settings, não estão escritos no componente')
test('nenhum script de WebGL ou three.js no bundle')
test('JS da rota inicial fica abaixo de 180 kB comprimido')
test('landing não tem rolagem horizontal em viewport de 360 px')
test('Lenis não é carregado quando reduced-motion está ativo')
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `npm test -- tests/unit/motion.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implementar a landing e as primitivas**

GSAP com `gsap.matchMedia()` para separar o comportamento de reduced-motion e de telas pequenas. `StreetGridDraw` lê o dataset e anima `stroke-dashoffset` dos caminhos. Lenis entra por import dinâmico, só quando o movimento está permitido. O hero da Fatia 1 usa **poster estático**; o vídeo Remotion entra na Fatia 6 sem alterar o layout.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `npm test -- tests/unit/motion.test.tsx && npx playwright test tests/e2e/landing.spec.ts tests/e2e/perf.spec.ts`
Expected: PASS

- [ ] **Step 5: Verificar em aparelho real**

Abrir o fluxo completo do cliente num Android de entrada na mesma rede e confirmar: busca de rua responde ao digitar, pedido conclui, rastreio atualiza. Registrar o resultado no commit.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: landing com malha de ruas animada e orçamento de performance"
```

---

## Definição de pronto da Fatia 1

- [ ] Todos os testes passam: `npm test && npx playwright test`
- [ ] Nenhuma tabela sem RLS
- [ ] Pedido criado nos três `kind`, incluindo um cruzando a fronteira
- [ ] Pedido concluído do início ao fim com o admin despachando
- [ ] Fluxo do cliente validado em Android de entrada
- [ ] Preços padrão revisados com um motoboy de Quaraí antes de abrir ao público

## Nota de escopo sobre edição pelo admin

A spec exige que taxa, raio, câmbio e textos sejam editáveis sem deploy, e este plano entrega isso: tudo mora em `pricing_rules`, `fx_rates`, `zones` e `settings`, e a landing lê seus textos de `settings`. O que **não** entra na Fatia 1 é a interface de edição — nesta fatia a alteração é feita pelo Supabase Studio, protegida pelas mesmas policies de `admin` e registrada em `audit_log`. O formulário do painel é a Fatia 5, e não exige nenhuma mudança de modelo de dados.
