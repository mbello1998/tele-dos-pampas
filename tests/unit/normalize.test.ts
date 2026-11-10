import { normalizeStreetName } from '@/lib/geo/normalize'

describe('normalizeStreetName', () => {
  test('"sao joao" query can match Avenida São João Batista do Quaraí', () => {
    const n = normalizeStreetName('Avenida São João Batista do Quaraí')
    expect(n).toBe('sao joao batista do quarai')
    expect(n.includes('sao joao')).toBe(true)
  })

  test('"bento" query matches Rua Bento Gonçalves', () => {
    const n = normalizeStreetName('Rua Bento Gonçalves')
    expect(n).toBe('bento goncalves')
    expect(n.includes('bento')).toBe(true)
  })

  test.each([
    ['Travessa Ana Rosa', 'ana rosa'],
    ['Beco do Sol', 'do sol'],
    ['Estrada Velha', 'velha'],
    ['Calle Rivera', 'rivera'],
    ['Camino Real', 'real'],
    ['Pasaje Sarandí', 'sarandi'],
    ['Av. Brasil', 'brasil'],
    ['av Brasil', 'brasil'],
    ['Rodovia João Simões Lopes Neto', 'joao simoes lopes neto'],
    ['Ruta 30', '30'],
    ['Praça Dom Pedro', 'dom pedro'],
    ['Plaza Independencia', 'independencia'],
    ['Alameda Santos', 'santos'],
    ['Bulevar Artigas', 'artigas'],
    ['Largo da Matriz', 'da matriz'],
    ['Rotonda Coronel Carlos Lecueder', 'coronel carlos lecueder'],
  ])('strips leading type word: %s', (input, expected) => {
    expect(normalizeStreetName(input)).toBe(expected)
  })

  test('keeps numeric names and only strips the leading type', () => {
    expect(normalizeStreetName('18 de Julio')).toBe('18 de julio')
    expect(normalizeStreetName('Rua Rua')).toBe('rua')
  })

  test('does not strip a type word that is just a prefix of another word', () => {
    expect(normalizeStreetName('Ruanda')).toBe('ruanda')
  })

  test('a name that is only a type word is kept', () => {
    expect(normalizeStreetName('Avenida')).toBe('avenida')
  })
})
