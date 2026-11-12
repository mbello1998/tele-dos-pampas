// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { putTrip, takeTrip } from '@/lib/trip/handoff'
import type { AddressInput } from '@/actions/addresses'

/**
 * A travessia existe por causa de um defeito concreto: a pessoa monta o trajeto sem conta, precisa entrar
 * para confirmar, e do outro lado do login encontrava duas listas vazias. O que estes testes protegem é que
 * o trajeto sobreviva — e que não sobreviva DEMAIS, que é o erro oposto.
 */

const endereco: AddressInput = {
  label: '',
  streetId: 'quarai-rua-andrade-neves',
  streetName: 'Rua Andrade Neves',
  number: '120',
  complement: '',
  betweenStreets: 'Entre A e B',
  reference: '',
  city: 'quarai',
  country: 'BR',
  lat: -30.3861,
  lng: -56.4529,
  precision: 'quadra',
}

const trajeto = {
  kind: 'ride' as const,
  from: { label: 'Rua Andrade Neves', detail: 'Quaraí', address: endereco },
  to: { label: 'Rua Duque de Caxias', detail: 'Quaraí', address: { ...endereco, streetName: 'Rua Duque de Caxias' } },
}

describe('travessia do trajeto pelo login', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.useRealTimers()
  })

  test('o que entra é o que sai, com o endereço inteiro', () => {
    putTrip(trajeto)
    const lido = takeTrip()!
    expect(lido.kind).toBe('ride')
    expect(lido.from.address?.streetName).toBe('Rua Andrade Neves')
    expect(lido.to.address?.streetName).toBe('Rua Duque de Caxias')
    // A quadra atravessa junto: é dela que sai a referência exigida para salvar o endereço.
    expect(lido.from.address?.betweenStreets).toBe('Entre A e B')
  })

  test('sem nada guardado, devolve null em vez de explodir', () => {
    expect(takeTrip()).toBeNull()
  })

  test('É LIDO UMA VEZ SÓ: um trajeto velho não pode reaparecer num pedido novo', () => {
    putTrip(trajeto)
    expect(takeTrip()).not.toBeNull()
    expect(takeTrip()).toBeNull()
  })

  test('passada a validade, não serve mais: preço muda e a pessoa já esqueceu o que pediu', () => {
    vi.useFakeTimers()
    putTrip(trajeto)
    vi.advanceTimersByTime(31 * 60_000)
    expect(takeTrip()).toBeNull()
  })

  test('dentro da validade, continua valendo', () => {
    vi.useFakeTimers()
    putTrip(trajeto)
    vi.advanceTimersByTime(20 * 60_000)
    expect(takeTrip()).not.toBeNull()
  })

  test('conteúdo corrompido não derruba a tela de confirmação', () => {
    sessionStorage.setItem('tdp.trajeto', '{isso não é json')
    expect(takeTrip()).toBeNull()
  })

  test('conteúdo pela metade é recusado: meio trajeto é pior que nenhum', () => {
    sessionStorage.setItem('tdp.trajeto', JSON.stringify({ kind: 'ride', at: Date.now() }))
    expect(takeTrip()).toBeNull()
  })

  test('o atalho de GPS atravessa sem endereço, e isso é esperado', () => {
    // Coordenada sem rua nem número: não dá para gravar como endereço, e a tela trata esse caso.
    putTrip({ ...trajeto, from: { label: 'Minha localização', detail: 'perto da Rua X', address: null } })
    expect(takeTrip()!.from.address).toBeNull()
  })

  test('guardar com o armazenamento bloqueado não lança: a travessia é conforto, não requisito', () => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('bloqueado')
    }
    expect(() => putTrip(trajeto)).not.toThrow()
    Storage.prototype.setItem = original
  })
})
