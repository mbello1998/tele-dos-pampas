import type { Client, QueryResult } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { connect } from '../../scripts/db/client'
import { TRACKING_ACTIVE_STATUSES } from '@/lib/realtime/position'
import { ID, FIXTURE_SQL, actAs, asOwner, attempt, type Who } from './rls-helpers'

/**
 * Privacidade da posição do motoboy (migration 0025).
 *
 * Quem pode ler courier_positions: o cliente DAQUELE pedido, só enquanto o pedido está ativo; o próprio
 * motoboy; a frota dele (só posições recentes, ver 0025); o admin. Ninguém mais, em momento nenhum.
 *
 * Fixtures: nada aqui depende de create_order. Tudo é INSERT direto em orders / order_events /
 * courier_positions dentro de UMA transação que termina em ROLLBACK. Cada teste roda num savepoint.
 *
 * Os papéis são exercitados como o PostgREST faz (set local role + request.jwt.claims), então as policies,
 * triggers e helpers que rodam são os reais.
 *
 * "Este teste falharia se a policy estivesse errada?" é respondido no bloco "mutantes" do fim: a lógica é
 * reconstruída em objetos TEMP (pg_temp) dentro da transação, com um defeito aplicado ao texto SQL, e a mesma
 * matriz de casos roda contra a cópia. Nenhuma policy ou função compartilhada é tocada.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 })

let db: Client

// --- identidades ---------------------------------------------------------------------------------------
const admin: Who = { uid: ID.admin }
const clientA: Who = { uid: ID.clientA }
const clientB: Who = { uid: ID.clientB }
const courierQ1: Who = { uid: ID.courierQ1 }
const courierQ2: Who = { uid: ID.courierQ2 }
const courierA1: Who = { uid: ID.courierA1 }
const merchant1: Who = { uid: ID.merchant1 }
const merchant2: Who = { uid: ID.merchant2 }
const fleet1: Who = { uid: ID.fleetOwner1 }
const fleet2: Who = { uid: ID.fleetOwner2 }
const pendingCourier: Who = { uid: ID.pendingCourier }
const blockedAdmin: Who = { uid: ID.blockedAdmin }

// --- dados extras (além de FIXTURE_SQL) ------------------------------------------------------------------
// FIXTURE_SQL: oFleet1 = cliente A, motoboy Q1 (frota 1), 'coletado', com UMA posição (lat -30.3875).
// oTakenQ2 = cliente A, motoboy Q2 (independente), 'aceito'.
const oB = 'c0000000-0000-4000-8000-0000000000b1' // cliente B, motoboy A1 (frota 2), 'em_rota'

/** Cada posição tem uma latitude única, que serve de rótulo. */
const LABELS: Record<string, string> = {
  '-30.3875': 'q1_o1', // do FIXTURE_SQL: Q1 no pedido de A, agora
  '-30.1001': 'q1_o1_b', // Q1 no pedido de A, agora
  '-30.1002': 'q2_o2', // Q2 no pedido de A (aceito), agora
  '-30.1003': 'a1_ob', // A1 no pedido de B, agora
  '-30.1004': 'q1_idle', // Q1 sem pedido, agora
  '-30.1005': 'q1_idle_old', // Q1 sem pedido, há 3 h
  '-30.1006': 'q2_idle', // Q2 sem pedido, agora
  '-30.1007': 'q1_on_ob', // Q1 gravou contra o pedido de B (que é de A1): não deveria existir, defesa em profundidade
  '-30.1008': 'q1_o1_old', // Q1 no pedido de A, há 3 h
}

const EXTRA_SQL = `
insert into public.orders (id, kind, client_id, merchant_id, courier_id, fleet_id, pickup_address, dropoff_address,
                           status, total_brl, total_charged, payment_method, pricing_breakdown, fx_rate_used) values
  ('${oB}', 'food', '${ID.clientB}', '${ID.shop2}', '${ID.courierA1}', '${ID.fleet2}',
   '{"city":"artigas","street_name":"Rua teste","number":"1"}', '{"city":"artigas","street_name":"Rua teste","number":"2"}',
   'em_rota', 60.00, 60.00, 'pix', '{"base": 10}', 7.8);

insert into public.order_events (order_id, from_status, to_status, actor_id, actor_role) values
  ('${ID.oFleet1}', 'criado', 'aguardando_loja', '${ID.clientA}', 'client');

insert into public.courier_positions (courier_id, order_id, lat, lng, recorded_at) values
  ('${ID.courierQ1}', '${ID.oFleet1}', -30.1001, -56.4501, now()),
  ('${ID.courierQ2}', '${ID.oTakenQ2}', -30.1002, -56.4502, now()),
  ('${ID.courierA1}', '${oB}', -30.1003, -56.4503, now()),
  ('${ID.courierQ1}', null, -30.1004, -56.4504, now()),
  ('${ID.courierQ1}', null, -30.1005, -56.4505, now() - interval '3 hours'),
  ('${ID.courierQ2}', null, -30.1006, -56.4506, now()),
  ('${ID.courierQ1}', '${oB}', -30.1007, -56.4507, now()),
  ('${ID.courierQ1}', '${ID.oFleet1}', -30.1008, -56.4508, now() - interval '3 hours');
`

const COURIERS = [ID.courierQ1, ID.courierQ2, ID.courierA1]
const scope = `courier_id in (${COURIERS.map((c) => `'${c}'`).join(',')})`

// --- execução --------------------------------------------------------------------------------------------
const asSql = (who: Who): string => {
  if (who === 'postgres') return `reset role; select set_config('request.jwt.claims', '', true);`
  if (who === 'anon') {
    return `reset role; select set_config('request.jwt.claims', '{"role":"anon"}', true); set local role anon;`
  }
  const claims = JSON.stringify({ role: 'authenticated', ...(who.uid ? { sub: who.uid } : {}) })
  return `reset role; select set_config('request.jwt.claims', '${claims}', true); set local role authenticated;`
}

type Case = {
  label: string
  /** 'deny': o ponto do teste é uma NEGATIVA (alguém NÃO vê algo). */
  kind: 'permit' | 'deny'
  /** SQL de preparo; recebe o alvo para que mudanças nas próprias posições valham na cópia temporária também. */
  setup?: string | ((target: string) => string)
  who: Who
  /** Rótulos (LABELS) que a leitura deve devolver, exatamente, entre as posições dos três motoboys. */
  expect: string[]
}

/** Uma ida ao banco: savepoint, preparo como dono, leitura como `who`, volta ao savepoint. */
async function readLabels(target: string, c: Pick<Case, 'setup' | 'who'>): Promise<string[]> {
  const sql = `savepoint c; reset role; ${typeof c.setup === 'function' ? c.setup(target) : (c.setup ?? 'select 1;')} ${asSql(c.who)}
    select lat::text as lat from ${target} where ${scope}; reset role; rollback to savepoint c;`
  let res: QueryResult | QueryResult[]
  try {
    res = await db.query(sql)
  } catch (e) {
    await db.query('rollback to savepoint c')
    // anon não tem nem o privilégio de SELECT na tabela: "permission denied" é uma negação, não um defeito.
    if (c.who === 'anon' && (e as { code?: string }).code === '42501') return []
    throw e
  }
  const hit = (Array.isArray(res) ? res : [res]).find((r) => r.fields?.[0]?.name === 'lat')
  if (!hit) throw new Error('a leitura não devolveu resultado')
  return hit.rows.map((r: { lat: string }) => LABELS[String(Number(r.lat))] ?? `?${r.lat}`).sort()
}

const sortedLabels = (l: string[]) => [...l].sort()

// --- a matriz de casos -----------------------------------------------------------------------------------
const A_ORDER = ['q1_o1', 'q1_o1_b', 'q1_o1_old'] // posições do pedido de A (oFleet1) ...
const A_VISIBLE = [...A_ORDER, 'q2_o2'] // ... mais a do pedido aceito de A (oTakenQ2)
const Q1_OWN = ['q1_o1', 'q1_o1_b', 'q1_o1_old', 'q1_idle', 'q1_idle_old', 'q1_on_ob']
const Q1_RECENT = ['q1_o1', 'q1_o1_b', 'q1_idle', 'q1_on_ob']
const EVERYTHING = Object.values(LABELS)

const setStatus = (s: string, ids = [ID.oFleet1]) =>
  `update public.orders set status = '${s}' where id in (${ids.map((i) => `'${i}'`).join(',')});`

// O enum order_status (0001). Um teste abaixo compara esta lista com o enum do banco: status novo reprova.
const ALL_STATUSES = [
  'criado', 'aguardando_loja', 'aguardando_motoboy', 'em_preparo', 'pronto', 'aceito', 'motoboy_chegou',
  'coletado', 'em_rota', 'em_viagem', 'entregue', 'finalizado', 'cancelado',
]

function buildCases(): Case[] {
  const active = new Set<string>(TRACKING_ACTIVE_STATUSES)
  const cases: Case[] = [
    { label: 'cliente A lê as posições dos próprios pedidos ativos e de mais ninguém', kind: 'permit', who: clientA, expect: A_VISIBLE },
    { label: 'cliente B lê só a posição do próprio pedido', kind: 'permit', who: clientB, expect: ['a1_ob'] },
    { label: 'o motoboy Q1 lê as próprias posições', kind: 'permit', who: courierQ1, expect: Q1_OWN },
    { label: 'NEGA: o motoboy Q2 não lê as posições de Q1 nem de A1', kind: 'deny', who: courierQ2, expect: ['q2_o2', 'q2_idle'] },
    { label: 'NEGA: o motoboy A1 não lê as posições de Q1 nem de Q2', kind: 'deny', who: courierA1, expect: ['a1_ob'] },
    { label: 'a frota 1 lê as posições recentes dos motoboys da própria frota', kind: 'permit', who: fleet1, expect: Q1_RECENT },
    { label: 'NEGA: a frota 2 não lê a frota 1 nem o motoboy independente', kind: 'deny', who: fleet2, expect: ['a1_ob'] },
    { label: 'o admin lê tudo', kind: 'permit', who: admin, expect: EVERYTHING },
    { label: 'NEGA: o lojista da loja do pedido não lê posição de motoboy', kind: 'deny', who: merchant1, expect: [] },
    { label: 'NEGA: o lojista da outra loja não lê posição de motoboy', kind: 'deny', who: merchant2, expect: [] },
    { label: 'NEGA: anônimo não lê nada', kind: 'deny', who: 'anon', expect: [] },
    { label: 'NEGA: motoboy com perfil pendente não lê nada', kind: 'deny', who: pendingCourier, expect: [] },
    { label: 'NEGA: admin bloqueado não lê nada', kind: 'deny', who: blockedAdmin, expect: [] },
  ]

  // O estado do pedido decide. Gerado a partir do enum do banco: um status novo sem classificação reprova.
  for (const s of ALL_STATUSES) {
    const isActive = active.has(s)
    cases.push({
      label: `${isActive ? 'cliente A lê' : 'NEGA: cliente A não lê'} a posição com o pedido em '${s}'`,
      kind: isActive ? 'permit' : 'deny',
      setup: setStatus(s),
      who: clientA,
      expect: isActive ? A_VISIBLE : ['q2_o2'],
    })
  }
  // Outro cliente: nunca, em nenhum status dos pedidos de A.
  for (const s of ALL_STATUSES) {
    cases.push({
      label: `NEGA: o cliente B não lê a posição dos pedidos de A com eles em '${s}'`,
      kind: 'deny',
      setup: setStatus(s, [ID.oFleet1, ID.oTakenQ2]),
      who: clientB,
      expect: ['a1_ob'],
    })
  }

  cases.push(
    {
      label: 'NEGA: cliente com perfil bloqueado não lê a posição do próprio pedido ativo',
      kind: 'deny',
      setup: `update public.profiles set status = 'blocked' where id = '${ID.clientA}';`,
      who: clientA,
      expect: [],
    },
    {
      label: 'NEGA: pedido repassado a outro motoboy: o cliente não lê as posições do motoboy anterior',
      kind: 'deny',
      setup: `update public.orders set courier_id = '${ID.courierQ2}', fleet_id = null where id = '${ID.oFleet1}';`,
      who: clientA,
      expect: ['q2_o2'],
    },
    {
      label: 'NEGA: pedido que mudou de dono: o antigo cliente deixa de ler',
      kind: 'deny',
      setup: `update public.orders set client_id = '${ID.clientB}' where id = '${ID.oFleet1}';`,
      who: clientA,
      expect: ['q2_o2'],
    },
    {
      label: 'NEGA: motoboy que saiu da frota deixa de ser lido por ela',
      kind: 'deny',
      setup: `update public.couriers set fleet_id = null where profile_id = '${ID.courierQ1}';`,
      who: fleet1,
      expect: [],
    },
    {
      label: 'NEGA: frota ainda pendente não lê motoboy nenhum',
      kind: 'deny',
      setup: `update public.fleets set status = 'pending' where id = '${ID.fleet1}';`,
      who: fleet1,
      expect: [],
    },
    {
      label: 'NEGA: dono de frota com perfil bloqueado não lê motoboy nenhum',
      kind: 'deny',
      setup: `update public.profiles set status = 'blocked' where id = '${ID.fleetOwner1}';`,
      who: fleet1,
      expect: [],
    },
    {
      label: 'janela da frota: posição de 14 min ainda é lida',
      kind: 'permit',
      setup: (t) => `update ${t} set recorded_at = now() - interval '14 minutes' where courier_id = '${ID.courierQ1}' and recorded_at > now() - interval '1 hour';`,
      who: fleet1,
      expect: Q1_RECENT,
    },
    {
      label: 'NEGA: janela da frota: posição de 16 min já não é lida',
      kind: 'deny',
      setup: (t) => `update ${t} set recorded_at = now() - interval '16 minutes' where courier_id = '${ID.courierQ1}' and recorded_at > now() - interval '1 hour';`,
      who: fleet1,
      expect: [],
    },
    {
      label: 'o motoboy que entra em outra frota passa a ser lido por ela, só nas posições recentes',
      kind: 'permit',
      setup: `update public.couriers set fleet_id = '${ID.fleet2}' where profile_id = '${ID.courierQ1}';`,
      who: fleet2,
      expect: ['a1_ob', ...Q1_RECENT],
    },
    {
      label: 'NEGA: depois que o motoboy troca de frota, a frota antiga não o lê mais',
      kind: 'deny',
      setup: `update public.couriers set fleet_id = '${ID.fleet2}' where profile_id = '${ID.courierQ1}';`,
      who: fleet1,
      expect: [],
    },
  )
  return cases
}

// --- ciclo de vida ---------------------------------------------------------------------------------------
beforeAll(async () => {
  db = await connect()
  await db.query('begin')
  await db.query(FIXTURE_SQL)
  await db.query(EXTRA_SQL)
})
afterAll(async () => {
  await db.query('rollback')
  await db.end()
})
beforeEach(async () => {
  await db.query('savepoint t')
})
afterEach(async () => {
  await db.query('rollback to savepoint t')
  await db.query('release savepoint t')
})

const LIVE = 'public.courier_positions'

describe('courier_positions: quem lê e quem não lê', () => {
  // O enum do banco é a fonte da verdade: qualquer status novo precisa ser classificado conscientemente.
  test('a lista de status ativos do TypeScript só contém status que existem e deixa os terminais de fora', async () => {
    const r = await db.query(`select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
      where t.typname = 'order_status' and t.typnamespace = 'public'::regnamespace order by e.enumsortorder`)
    expect(r.rows.map((x) => x.enumlabel)).toEqual(ALL_STATUSES)
    for (const s of TRACKING_ACTIVE_STATUSES) expect(ALL_STATUSES).toContain(s)
    for (const s of ['criado', 'aguardando_loja', 'aguardando_motoboy', 'entregue', 'finalizado', 'cancelado']) {
      expect(TRACKING_ACTIVE_STATUSES as readonly string[]).not.toContain(s)
    }
  })

  for (const c of buildCases()) {
    test(`${c.kind === 'permit' ? 'PERMITE' : 'NEGA'} | ${c.label.replace(/^NEGA: /, '')}`, async () => {
      expect(await readLabels(LIVE, c)).toEqual(sortedLabels(c.expect))
    })
  }
})

describe('os cenários descritos no brief, em sequência', () => {
  test('PERMITE | cliente do pedido lê a posição do motoboy enquanto o pedido está ativo', async () => {
    expect(await readLabels(LIVE, { who: clientA })).toEqual(expect.arrayContaining(['q1_o1', 'q1_o1_b']))
  })

  test('NEGA | cliente NÃO lê a posição depois de o pedido ser entregue (a mesma sessão, antes e depois)', async () => {
    expect(await readLabels(LIVE, { who: clientA })).toContain('q1_o1')
    // a entrega acontece: o mesmo cliente, o mesmo pedido, a mesma posição
    const after = await readLabels(LIVE, { who: clientA, setup: `${setStatus('entregue')}` })
    expect(after).not.toContain('q1_o1')
    expect(after).not.toContain('q1_o1_b')
    expect(after).not.toContain('q1_o1_old')
    // nem a posição mais nova: gravar uma posição nova depois da entrega também não aparece
    const late = await readLabels(LIVE, {
      who: clientA,
      setup: `${setStatus('entregue')}
        insert into public.courier_positions (courier_id, order_id, lat, lng) values ('${ID.courierQ1}', '${ID.oFleet1}', -30.1001, -56.4501);`,
    })
    expect(late).toEqual(['q2_o2'])
  })

  test('NEGA | outro cliente NÃO lê a posição em nenhum momento', async () => {
    for (const s of ALL_STATUSES) {
      const seen = await readLabels(LIVE, { who: clientB, setup: setStatus(s, [ID.oFleet1, ID.oTakenQ2]) })
      expect(seen, `cliente B com os pedidos de A em '${s}'`).toEqual(['a1_ob'])
    }
  })

  test('PERMITE | fleet lê a posição dos motoboys da própria frota', async () => {
    expect(await readLabels(LIVE, { who: fleet1 })).toEqual(sortedLabels(Q1_RECENT))
  })
})

describe('courier_positions: escrita continua fechada', () => {
  const insert = (courier: string, order: string | null) =>
    `insert into public.courier_positions (courier_id, order_id, lat, lng) values ('${courier}', ${order ? `'${order}'` : 'null'}, -30.2, -56.4)`

  test('NEGA | cliente não grava posição, nem com o id do motoboy', async () => {
    await actAs(db, clientA)
    const a = await attempt(db, insert(ID.courierQ1, ID.oFleet1))
    expect(a.ok).toBe(false)
    const b = await attempt(db, insert(ID.clientA, ID.oFleet1))
    expect(b.ok).toBe(false)
  })

  test('NEGA | motoboy não grava posição contra pedido que não é dele', async () => {
    await actAs(db, courierQ2)
    const a = await attempt(db, insert(ID.courierQ2, ID.oFleet1))
    expect(a.ok).toBe(false)
    expect(!a.ok && a.code).toBe('42501')
  })

  test('NEGA | motoboy não grava posição em nome de outro motoboy', async () => {
    await actAs(db, courierQ2)
    const a = await attempt(db, insert(ID.courierQ1, null))
    expect(a.ok).toBe(false)
  })

  test('NEGA | frota e lojista não gravam posição', async () => {
    for (const who of [fleet1, merchant1]) {
      await actAs(db, who)
      const a = await attempt(db, insert(ID.courierQ1, ID.oFleet1))
      expect(a.ok).toBe(false)
    }
  })

  test('NEGA | ninguém além do admin altera ou apaga uma posição', async () => {
    const before = (await asOwner(db, `select count(*)::int n from public.courier_positions where ${scope}`))[0].n
    for (const who of [clientA, courierQ1, fleet1, merchant1]) {
      await actAs(db, who)
      const u = await attempt(db, `update public.courier_positions set lat = 0 where ${scope}`)
      if (u.ok) expect(u.rowCount).toBe(0)
      const d = await attempt(db, `delete from public.courier_positions where ${scope}`)
      if (d.ok) expect(d.rowCount).toBe(0)
    }
    const after = (await asOwner(db, `select count(*)::int n from public.courier_positions where ${scope}`))[0].n
    expect(after).toBe(before)
    const moved = await asOwner(db, `select count(*)::int n from public.courier_positions where ${scope} and lat = 0`)
    expect(moved[0].n).toBe(0)
  })

  test('PERMITE | o motoboy do pedido continua gravando a própria posição contra o próprio pedido', async () => {
    await actAs(db, courierQ1)
    const a = await attempt(db, insert(ID.courierQ1, ID.oFleet1))
    expect(a.ok).toBe(true)
    const idle = await attempt(db, insert(ID.courierQ1, null))
    expect(idle.ok).toBe(true)
  })
})

describe('timeline e canal em tempo real', () => {
  test('PERMITE | o cliente lê os eventos do próprio pedido (a timeline), e só desses', async () => {
    await actAs(db, clientA)
    const mine = await db.query(`select to_status from public.order_events where order_id = '${ID.oFleet1}'`)
    expect(mine.rows.map((r) => r.to_status)).toEqual(expect.arrayContaining(['aguardando_loja', 'coletado']))
    await actAs(db, clientB)
    const theirs = await db.query(`select to_status from public.order_events where order_id = '${ID.oFleet1}'`)
    expect(theirs.rows).toEqual([])
  })

  test('courier_positions e order_events estão na publicação do Realtime (que respeita a RLS de quem escuta)', async () => {
    await actAs(db, 'postgres')
    const r = await db.query(
      `select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'`,
    )
    const names = r.rows.map((x) => x.tablename)
    expect(names).toContain('courier_positions')
    expect(names).toContain('order_events')
    // orders carrega valores e comissão: o rastreio não precisa dela no canal
    expect(names).not.toContain('orders')
  })

  test('o provedor de tiles vem de settings, é público e é um modelo de URL', async () => {
    await actAs(db, 'anon')
    const r = await db.query(`select value from public.settings where key = 'map.tile_url'`)
    expect(r.rows).toHaveLength(1)
    const url = String(r.rows[0].value)
    expect(url).toMatch(/^https:\/\//)
    for (const token of ['{z}', '{x}', '{y}']) expect(url).toContain(token)
  })
})

// =========================================================================================================
// MUTANTES. A pergunta: se a policy estivesse errada, algum teste acima reprovaria?
//
// A policy e suas funções são reconstruídas em pg_temp a partir das definições VIVAS (pg_get_functiondef,
// pg_get_expr), com um defeito aplicado ao texto. A MESMA matriz de casos roda contra a cópia. 'baseline'
// (sem defeito) tem de passar tudo: prova que a cópia é equivalente ao que está no ar. Todo outro mutante tem
// de reprovar pelo menos um caso, e o caso tem de ser o esperado (um mutante pego por acidente não conta).
// Cada edição precisa casar no texto: mutante velho que deixou de casar lança erro em vez de "passar".
// =========================================================================================================
type Edit = { from: string | RegExp; to: string }
type Mutant = {
  /** edições no corpo de private.client_may_track */
  client?: Edit[]
  /** edições no corpo de private.fleet_may_see_position */
  fleet?: Edit[]
  /** edições na expressão de uma policy de SELECT, por nome */
  policy?: Record<string, Edit[]>
  /** policy extra, criada como se alguém a tivesse adicionado */
  extraPolicy?: string
  /** remove uma policy */
  dropPolicy?: string
  rlsOff?: boolean
  /** rótulos de caso (trechos) dos quais ao menos um tem de reprovar */
  caughtBy: string[]
}

function apply(text: string, edits: Edit[] | undefined, what: string): string {
  let out = text
  for (const e of edits ?? []) {
    const hit = typeof e.from === 'string' ? out.includes(e.from) : e.from.test(out)
    if (!hit) throw new Error(`mutante velho em ${what}: não casa ${String(e.from)}`)
    out = typeof e.from === 'string' ? out.replace(e.from, e.to) : out.replace(e.from, e.to)
  }
  return out
}

async function buildTarget(m: Mutant): Promise<string> {
  await db.query(`reset role`)
  await db.query(`create temp table pos_m (like public.courier_positions including defaults)`)
  await db.query(`insert into pg_temp.pos_m select * from public.courier_positions`)
  await db.query(`grant select on pg_temp.pos_m to authenticated, anon`)
  if (!m.rlsOff) await db.query(`alter table pg_temp.pos_m enable row level security`)

  const def = async (sig: string) =>
    (await db.query(`select pg_get_functiondef('${sig}'::regprocedure) as d`)).rows[0].d as string
  const clientDef = await def('private.client_may_track(uuid, uuid)')
  const fleetDef = await def('private.fleet_may_see_position(uuid, timestamptz)')
  const rename = (d: string, from: string, to: string) => d.replace(new RegExp(from.replace('.', '\\.'), 'g'), to)

  const clientM = apply(rename(clientDef, 'private.client_may_track', 'pg_temp.client_may_track_m'), m.client, 'client_may_track')
  const fleetM = apply(rename(fleetDef, 'private.fleet_may_see_position', 'pg_temp.fleet_may_see_position_m'), m.fleet, 'fleet_may_see_position')
  await db.query(clientM)
  await db.query(fleetM)

  const pol = await db.query(`
    select polname, pg_get_expr(polqual, polrelid) as q from pg_policy
    where polrelid = 'public.courier_positions'::regclass and polcmd = 'r'`)
  if (pol.rows.length < 4) throw new Error(`esperava as policies de SELECT (own, admin, client, fleet), achei ${pol.rows.length}`)
  for (const row of pol.rows) {
    if (m.dropPolicy === row.polname) continue
    let q = String(row.q)
      .replace(/private\.client_may_track\(/g, 'pg_temp.client_may_track_m(')
      .replace(/private\.fleet_may_see_position\(/g, 'pg_temp.fleet_may_see_position_m(')
    q = apply(q, m.policy?.[row.polname], `policy ${row.polname}`)
    await db.query(`create policy "${row.polname}" on pg_temp.pos_m for select to authenticated using (${q})`)
  }
  if (m.dropPolicy && !pol.rows.some((r) => r.polname === m.dropPolicy)) throw new Error(`policy ${m.dropPolicy} não existe`)
  if (m.extraPolicy) await db.query(`create policy extra_m on pg_temp.pos_m for select to authenticated using (${m.extraPolicy})`)
  return 'pg_temp.pos_m'
}

/** Roda a matriz inteira contra um alvo e devolve os rótulos dos casos que NÃO deram o esperado. */
async function failingCases(target: string): Promise<string[]> {
  const failed: string[] = []
  for (const c of buildCases()) {
    const got = await readLabels(target, c)
    if (JSON.stringify(got) !== JSON.stringify(sortedLabels(c.expect))) failed.push(c.label)
  }
  return failed
}

const MUTANTS: Record<string, Mutant> = {
  // ---- o cliente
  'cliente: entregue volta a ser ativo': {
    client: [{ from: `'em_viagem'`, to: `'em_viagem', 'entregue'` }],
    caughtBy: [`NEGA: cliente A não lê a posição com o pedido em 'entregue'`],
  },
  'cliente: finalizado volta a ser ativo': {
    client: [{ from: `'em_viagem'`, to: `'em_viagem', 'finalizado'` }],
    caughtBy: [`em 'finalizado'`],
  },
  'cliente: cancelado volta a ser ativo': {
    client: [{ from: `'em_viagem'`, to: `'em_viagem', 'cancelado'` }],
    caughtBy: [`em 'cancelado'`],
  },
  'cliente: pedido ainda não aceito conta como ativo': {
    client: [{ from: `'em_viagem'`, to: `'em_viagem', 'criado', 'aguardando_loja', 'aguardando_motoboy'` }],
    caughtBy: [`em 'criado'`, `em 'aguardando_motoboy'`],
  },
  'cliente: o status deixa de ser conferido': {
    client: [{ from: /and o\.status in \([^)]*\)/, to: 'and true' }],
    caughtBy: [`em 'entregue'`, `em 'cancelado'`, `em 'criado'`],
  },
  'cliente: o status vira lista negra só com entregue (um status novo vazaria)': {
    client: [{ from: /and o\.status in \([^)]*\)/, to: `and o.status <> 'entregue'` }],
    caughtBy: [`em 'finalizado'`, `em 'cancelado'`, `em 'criado'`],
  },
  'cliente: qualquer cliente serve (sem checar o dono do pedido)': {
    client: [{ from: /o\.client_id = \(select auth\.uid\(\)\)\s*and/, to: '' }],
    caughtBy: ['NEGA: o cliente B não lê a posição dos pedidos de A', 'NEGA: pedido que mudou de dono'],
  },
  'cliente: a posição não precisa ser do motoboy atual do pedido': {
    client: [{ from: /and o\.courier_id = p_courier/, to: '' }],
    caughtBy: ['NEGA: pedido repassado a outro motoboy'],
  },
  'cliente: perfil bloqueado continua lendo': {
    client: [{ from: /and \(select public\.app_role\(\)\) is not null/, to: '' }],
    caughtBy: ['NEGA: cliente com perfil bloqueado'],
  },
  'cliente: posição sem pedido (parado) também aparece': {
    policy: { courier_positions_select_client: [{ from: /^/, to: '(order_id IS NULL) OR ' }] },
    caughtBy: ['cliente A lê as posições dos próprios pedidos ativos e de mais ninguém'],
  },
  'cliente: a policy do cliente é removida': {
    dropPolicy: 'courier_positions_select_client',
    caughtBy: ['cliente A lê as posições dos próprios pedidos ativos', `cliente A lê a posição com o pedido em 'coletado'`],
  },

  // ---- a frota
  'frota: qualquer frota lê qualquer motoboy de frota': {
    fleet: [{ from: /c\.fleet_id in \(select private\.owned_fleet_ids\(\)\)/, to: 'c.fleet_id is not null' }],
    caughtBy: ['NEGA: a frota 2 não lê a frota 1'],
  },
  'frota: a janela de recência some (o histórico inteiro vaza)': {
    fleet: [{ from: /and p_recorded > now\(\) - interval '15 minutes'/, to: '' }],
    caughtBy: ['NEGA: janela da frota', 'a frota 1 lê as posições recentes'],
  },
  'frota: a janela passa de 15 min para 6 h': {
    fleet: [{ from: `interval '15 minutes'`, to: `interval '6 hours'` }],
    caughtBy: ['NEGA: janela da frota: posição de 16 min'],
  },
  'frota: não confere o motoboy da linha (lê qualquer motoboy se tem algum na frota)': {
    fleet: [{ from: /c\.profile_id = p_courier\s*and/, to: '' }],
    caughtBy: ['NEGA: a frota 2 não lê a frota 1 nem o motoboy independente', 'a frota 1 lê as posições recentes'],
  },
  'frota: frota pendente ou de dono bloqueado também lê': {
    fleet: [
      {
        from: /c\.fleet_id in \(select private\.owned_fleet_ids\(\)\)/,
        to: `c.fleet_id in (select f.id from public.fleets f where f.owner_id = (select auth.uid()))`,
      },
    ],
    caughtBy: ['NEGA: frota ainda pendente', 'NEGA: dono de frota com perfil bloqueado'],
  },
  'frota: a policy da frota é removida': {
    dropPolicy: 'courier_positions_select_fleet',
    caughtBy: ['a frota 1 lê as posições recentes'],
  },

  // ---- as policies antigas e as que alguém poderia somar
  'motoboy: a policy "own" perde a checagem do dono (todo motoboy lê todos)': {
    policy: { courier_positions_select_own: [{ from: /^\(\(courier_id = \( SELECT auth\.uid\(\) AS uid\)\) AND/, to: '((true) AND' }] },
    caughtBy: ['NEGA: o motoboy Q2 não lê', 'NEGA: o motoboy A1 não lê'],
  },
  'admin: a policy do admin vira "todos" (lojista e anônimo passam a ler)': {
    policy: { courier_positions_select_admin: [{ from: /^[\s\S]*$/, to: 'true' }] },
    caughtBy: ['NEGA: o lojista', 'NEGA: anônimo', 'NEGA: motoboy com perfil pendente'],
  },
  'lojista: alguém soma uma policy que deixa o lojista do pedido ler': {
    extraPolicy: `exists (select 1 from public.orders o where o.id = order_id and o.merchant_id in (select private.owned_merchant_ids()))`,
    caughtBy: ['NEGA: o lojista da loja do pedido'],
  },
  'a RLS é desligada na tabela': {
    rlsOff: true,
    caughtBy: ['NEGA: anônimo', 'NEGA: o lojista', 'NEGA: o motoboy Q2'],
  },
}

describe('mutantes: a matriz de casos pega policy errada', () => {
  test('baseline: a cópia reconstruída em pg_temp, sem defeito, passa toda a matriz', async () => {
    await db.query('savepoint m')
    try {
      const target = await buildTarget({ caughtBy: [] })
      expect(await failingCases(target)).toEqual([])
    } finally {
      await db.query('rollback to savepoint m')
    }
  })

  for (const [name, mutant] of Object.entries(MUTANTS)) {
    test(`mutante: ${name}`, async () => {
      await db.query('savepoint m')
      try {
        const target = await buildTarget(mutant)
        const failed = await failingCases(target)
        expect(failed.length, `o mutante "${name}" SOBREVIVEU: nenhum caso reprovou`).toBeGreaterThan(0)
        const expected = mutant.caughtBy.some((frag) => failed.some((f) => f.includes(frag)))
        expect(expected, `pego, mas não pelo caso esperado. Reprovaram: ${failed.join(' | ')}`).toBe(true)
      } finally {
        await db.query('rollback to savepoint m')
      }
    })
  }
})
