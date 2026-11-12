import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type { Client } from 'pg'
import { connect } from '../../scripts/db/client'
import { actAs, attempt, FIXTURE_SQL, ID } from './rls-helpers'

/**
 * "Furei o pneu, passa pra outro." O que estes testes protegem é a linha que foi traçada: devolver é possível
 * ANTES de pegar a carga, e impossível depois. Afrouxar isso criaria o caso em que o motoboy some com a
 * sacola do cliente e o pedido volta para a fila como se nada tivesse acontecido.
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

const devolver = (orderId: string, motivo = 'Furei o pneu') =>
  attempt(db, 'select public.release_order($1, $2) as r', [orderId, motivo])

const pedido = async (id: string) => {
  await actAs(db, 'postgres')
  const r = await db.query('select status::text as status, courier_id from public.orders where id = $1', [id])
  return r.rows[0] as { status: string; courier_id: string | null }
}

describe('devolver o chamado à fila', () => {
  test('o motoboy atribuído devolve, e o chamado volta para a fila sem dono', async () => {
    await actAs(db, { uid: ID.courierQ2 })
    const r = await devolver(ID.oTakenQ2)
    expect(r.ok).toBe(true)

    const depois = await pedido(ID.oTakenQ2)
    expect(depois.status).toBe('aguardando_motoboy')
    // Sem isto o chamado voltaria para a fila ainda marcado com o nome dele.
    expect(depois.courier_id).toBeNull()
  })

  test('O MOTIVO VIRA MENSAGEM NO CHAT: devolver em silêncio deixa quem espera sem explicação', async () => {
    await actAs(db, { uid: ID.courierQ2 })
    await devolver(ID.oTakenQ2, 'Furei o pneu na Bento Gonçalves')

    await actAs(db, 'postgres')
    const r = await db.query('select body, sender_role::text as papel from public.order_messages where order_id = $1', [
      ID.oTakenQ2,
    ])
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0].body).toBe('Furei o pneu na Bento Gonçalves')
    expect(r.rows[0].papel).toBe('courier')
  })

  test('fica registrado no histórico do pedido, com o motivo', async () => {
    await actAs(db, { uid: ID.courierQ2 })
    await devolver(ID.oTakenQ2, 'Problema na moto')

    await actAs(db, 'postgres')
    const r = await db.query(
      `select note, to_status::text as para from public.order_events where order_id = $1 order by id desc limit 1`,
      [ID.oTakenQ2],
    )
    expect(r.rows[0].para).toBe('aguardando_motoboy')
    expect(r.rows[0].note).toContain('Problema na moto')
  })

  test('outro motoboy não devolve o chamado alheio', async () => {
    await actAs(db, { uid: ID.courierQ1 })
    const r = await devolver(ID.oTakenQ2)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe('TD010')
  })

  test('o cliente não devolve o próprio pedido por aqui: esta porta é do motoboy', async () => {
    await actAs(db, { uid: ID.clientA })
    const r = await devolver(ID.oTakenQ2)
    expect(r.ok).toBe(false)
  })

  test('COM A CARGA A BORDO É RECUSADO: repassar vira encontro na rua, não botão', async () => {
    // oFleet1 é uma entrega já COLETADA pelo courierQ1: a sacola está na garupa dele.
    await actAs(db, { uid: ID.courierQ1 })
    const r = await devolver(ID.oFleet1)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe('23514')

    // E o pedido não se mexeu.
    const depois = await pedido(ID.oFleet1)
    expect(depois.status).toBe('coletado')
    expect(depois.courier_id).toBe(ID.courierQ1)
  })

  test('motivo vazio é recusado: é ele que o cliente vai ler', async () => {
    await actAs(db, { uid: ID.courierQ2 })
    expect((await devolver(ID.oTakenQ2, '  ')).ok).toBe(false)
    expect((await devolver(ID.oTakenQ2, 'ab')).ok).toBe(false)
  })

  test('motivo gigante é recusado', async () => {
    await actAs(db, { uid: ID.courierQ2 })
    expect((await devolver(ID.oTakenQ2, 'x'.repeat(301))).ok).toBe(false)
  })

  test('pedido inexistente não derruba a função', async () => {
    await actAs(db, { uid: ID.courierQ2 })
    const r = await devolver('00000000-0000-0000-0000-0000000000ff')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.code).toBe('TD002')
  })

  test('depois de devolver, outro motoboy encontra o chamado na fila', async () => {
    await actAs(db, { uid: ID.courierQ2 })
    await devolver(ID.oTakenQ2)

    await actAs(db, { uid: ID.courierQ1 })
    // `courier_orders`, não `orders`: o SELECT direto do motoboy na tabela é revogado de propósito — a view
    // é que esconde a estrutura de preço. Ler a tabela aqui testaria uma porta que nem existe para ele.
    const r = await attempt(db, 'select id from public.courier_orders where id = $1', [ID.oTakenQ2])
    // É o teste que fecha o ciclo: devolver sem que a fila enxergue não teria servido para nada.
    expect(r.ok && r.rows.length).toBe(1)
  })
})
