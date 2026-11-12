import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type { Client } from 'pg'
import { connect } from '../../scripts/db/client'
import { actAs, attempt, FIXTURE_SQL, ID } from './rls-helpers'

/**
 * O chat do pedido é a conversa entre duas pessoas sobre onde fica a porta da casa de uma delas. O que estes
 * testes protegem não é a funcionalidade — é QUEM PODE LER. Um furo aqui não aparece na tela: aparece quando
 * alguém descobre que a fila inteira de motoboys lia o que o cliente escreveu.
 */

let db: Client

beforeAll(async () => {
  db = await connect()
})
afterAll(async () => {
  await db.end()
})
beforeEach(async () => {
  await db.query('begin')
  await db.query(FIXTURE_SQL)
})
afterEach(async () => {
  await db.query('rollback')
})

/** `oTakenQ2` é do clientA e está com o courierQ2: o par que pode conversar. */
const PEDIDO = ID.oTakenQ2

const insere = (quem: string, orderId: string, papel = 'client', corpo = 'oi') =>
  attempt(
    db,
    `insert into public.order_messages (order_id, sender_id, sender_role, kind, body) values ($1, $2, $3::public.user_role, 'texto', $4) returning id`,
    [orderId, quem, papel, corpo],
  )

async function semeia(orderId = PEDIDO) {
  await actAs(db, 'postgres')
  await db.query(
    `insert into public.order_messages (order_id, sender_id, sender_role, kind, body)
     values ($1, $2, 'client', 'texto', 'estou no portão azul')`,
    [orderId, ID.clientA],
  )
}

async function leComo(who: Parameters<typeof actAs>[1]): Promise<number> {
  await actAs(db, who)
  const r = await attempt(db, 'select id from public.order_messages where order_id = $1', [PEDIDO])
  return r.ok ? r.rows.length : -1
}

describe('quem lê a conversa', () => {
  test('o cliente daquele pedido lê', async () => {
    await semeia()
    expect(await leComo({ uid: ID.clientA })).toBe(1)
  })

  test('o motoboy ATRIBUÍDO àquele pedido lê', async () => {
    await semeia()
    expect(await leComo({ uid: ID.courierQ2 })).toBe(1)
  })

  test('OUTRO motoboy da mesma cidade NÃO lê, mesmo vendo o pedido na fila', async () => {
    await semeia()
    expect(await leComo({ uid: ID.courierQ1 })).toBe(0)
  })

  test('outro cliente não lê', async () => {
    await semeia()
    expect(await leComo({ uid: ID.clientB })).toBe(0)
  })

  test('a loja não lê a conversa do cliente com o motoboy', async () => {
    await semeia()
    expect(await leComo({ uid: ID.merchant1 })).toBe(0)
  })

  test('a frota não lê', async () => {
    await semeia()
    expect(await leComo({ uid: ID.fleetOwner1 })).toBe(0)
  })

  test('o admin lê, porque é quem resolve reclamação', async () => {
    await semeia()
    expect(await leComo({ uid: ID.admin })).toBe(1)
  })

  test('anônimo é RECUSADO na tabela, não devolve lista vazia', async () => {
    await semeia()
    await actAs(db, 'anon')
    const r = await attempt(db, 'select id from public.order_messages where order_id = $1', [PEDIDO])
    // Garantia mais forte que "zero linhas": `anon` não tem permissão nenhuma na tabela, então a consulta
    // nem chega à policy. Visitante sem conta não tem como nem perguntar se existe conversa.
    expect(r.ok).toBe(false)
  })
})

describe('quem escreve', () => {
  test('o cliente e o motoboy daquele pedido escrevem', async () => {
    await actAs(db, { uid: ID.clientA })
    expect((await insere(ID.clientA, PEDIDO, 'client')).ok).toBe(true)
    await actAs(db, { uid: ID.courierQ2 })
    expect((await insere(ID.courierQ2, PEDIDO, 'courier')).ok).toBe(true)
  })

  test('um motoboy de fora não escreve', async () => {
    await actAs(db, { uid: ID.courierQ1 })
    expect((await insere(ID.courierQ1, PEDIDO, 'courier')).ok).toBe(false)
  })

  test('O ADMIN NÃO ESCREVE: ninguém deve poder se passar por um dos dois lados', async () => {
    await actAs(db, { uid: ID.admin })
    expect((await insere(ID.admin, PEDIDO, 'admin')).ok).toBe(false)
  })

  test('não dá para assinar mensagem com o id do outro', async () => {
    await actAs(db, { uid: ID.courierQ2 })
    // O motoboy tentando falar como se fosse o cliente, no pedido dele mesmo.
    expect((await insere(ID.clientA, PEDIDO, 'client')).ok).toBe(false)
  })

  test('pedido encerrado: ainda se lê, mas ninguém escreve', async () => {
    await semeia()
    await actAs(db, 'postgres')
    await db.query(`update public.orders set status = 'entregue' where id = $1`, [PEDIDO])

    expect(await leComo({ uid: ID.clientA })).toBe(1)
    await actAs(db, { uid: ID.clientA })
    expect((await insere(ID.clientA, PEDIDO, 'client')).ok).toBe(false)
  })
})

describe('o que pode ser dito', () => {
  test('texto vazio é recusado pelo banco, não só pela tela', async () => {
    await actAs(db, { uid: ID.clientA })
    expect((await insere(ID.clientA, PEDIDO, 'client', '   ')).ok).toBe(false)
  })

  test("'foto' sem foto é recusada: a tela quebraria na mão de quem dirige", async () => {
    await actAs(db, { uid: ID.clientA })
    const r = await attempt(
      db,
      `insert into public.order_messages (order_id, sender_id, sender_role, kind) values ($1, $2, 'client', 'foto')`,
      [PEDIDO, ID.clientA],
    )
    expect(r.ok).toBe(false)
  })

  test("'local' fora das duas cidades é recusado: GPS que falhou não vira mensagem", async () => {
    await actAs(db, { uid: ID.clientA })
    const r = await attempt(
      db,
      `insert into public.order_messages (order_id, sender_id, sender_role, kind, lat, lng) values ($1, $2, 'client', 'local', -23.5, -46.6)`,
      [PEDIDO, ID.clientA],
    )
    expect(r.ok).toBe(false)
  })

  test("'local' dentro da região passa", async () => {
    await actAs(db, { uid: ID.clientA })
    const r = await attempt(
      db,
      `insert into public.order_messages (order_id, sender_id, sender_role, kind, lat, lng) values ($1, $2, 'client', 'local', -30.3861, -56.4529)`,
      [PEDIDO, ID.clientA],
    )
    expect(r.ok).toBe(true)
  })
})

describe('a conversa é imutável', () => {
  test('ninguém edita o texto depois de enviado: conversa editável não serve de combinado', async () => {
    await semeia()
    await actAs(db, { uid: ID.courierQ2 })
    const r = await attempt(db, `update public.order_messages set body = 'outra coisa' where order_id = $1`, [PEDIDO])
    expect(r.ok).toBe(false)
  })

  test('o destinatário pode marcar como lida', async () => {
    await semeia()
    await actAs(db, { uid: ID.courierQ2 })
    const r = await attempt(db, `update public.order_messages set read_at = now() where order_id = $1`, [PEDIDO])
    expect(r.ok).toBe(true)
  })

  test('quem enviou não marca a própria mensagem como lida', async () => {
    await semeia()
    await actAs(db, { uid: ID.clientA })
    const r = await attempt(db, `update public.order_messages set read_at = now() where order_id = $1`, [PEDIDO])
    expect(r.ok).toBe(true)
    // A policy filtra as linhas em vez de levantar: o que importa é que NENHUMA foi marcada.
    expect(r.ok && r.rowCount).toBe(0)
  })

  test('NINGUÉM apaga, nem o admin: apagar mensagem é apagar prova', async () => {
    await semeia()
    for (const quem of [ID.clientA, ID.courierQ2, ID.admin]) {
      await actAs(db, { uid: quem })
      const r = await attempt(db, 'delete from public.order_messages where order_id = $1', [PEDIDO])
      expect(r.ok && r.rowCount).toBe(0)
    }
  })
})
