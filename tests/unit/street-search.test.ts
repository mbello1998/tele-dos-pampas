import { readFileSync } from 'node:fs'
import { normalizeStreetName } from '@/lib/geo/normalize'
import { searchStreets } from '@/lib/geo/search'
import type { City, Country, Street, StreetDataset } from '@/lib/geo/types'

function street(name: string, city: City, country: Country, id: string): Street {
  return {
    id,
    name,
    nameNormalized: normalizeStreetName(name),
    city,
    country,
    segments: [],
    intersections: [],
  }
}

function dataset(city: City, country: Country, names: string[]): StreetDataset {
  return {
    city,
    country,
    streets: names.map((n, i) => street(n, city, country, `${city}-${i}`)),
    references: [],
  }
}

const quarai = dataset('quarai', 'BR', [
  'Avenida São João Batista do Quaraí',
  'Rua Bento Gonçalves',
  'Rua Gonçalves Dias',
  'Rua Bento Manoel',
  'Rua Sete de Setembro',
  'Puente de la Concordia',
])
const artigas = dataset('artigas', 'UY', [
  '18 de Julio',
  'Calle Rivera',
  'Puente de la Concordia',
  'Avenida Lecueder',
])
const both = [quarai, artigas]

describe('searchStreets', () => {
  test('"sao joao" encontra "Avenida São João Batista do Quaraí"', () => {
    const hits = searchStreets('sao joao', both)
    expect(hits.map((h) => h.name)).toContain('Avenida São João Batista do Quaraí')
  })

  test('query com acento encontra nome sem acento e vice-versa', () => {
    expect(searchStreets('São João', both)[0].name).toBe('Avenida São João Batista do Quaraí')
    const plain = dataset('quarai', 'BR', ['Rua Joao Pessoa'])
    expect(searchStreets('joão', [plain])[0].name).toBe('Rua Joao Pessoa')
  })

  test('ignora prefixo: "bento" encontra "Rua Bento Gonçalves"', () => {
    const hits = searchStreets('bento', both)
    expect(hits.map((h) => h.name)).toContain('Rua Bento Gonçalves')
  })

  test('ignora o tipo de via digitado na query', () => {
    const hits = searchStreets('rua bento', both)
    expect(hits[0].name.startsWith('Rua Bento')).toBe(true)
  })

  test('três letras já retornam resultado', () => {
    expect(searchStreets('ben', both).length).toBeGreaterThan(0)
    expect(searchStreets('riv', both)[0].name).toBe('Calle Rivera')
  })

  test('tolera um erro de digitação: "gonzalves" encontra "Gonçalves"', () => {
    const names = searchStreets('gonzalves', both).map((h) => h.name)
    expect(names).toContain('Rua Bento Gonçalves')
    expect(names).toContain('Rua Gonçalves Dias')
  })

  test('não faz fuzzy com query curta demais (sem ruído)', () => {
    expect(searchStreets('zzz', both)).toEqual([])
  })

  test('ordena por score, prefixo exato primeiro', () => {
    const hits = searchStreets('goncalves', both)
    // "Gonçalves Dias" starts with the query; "Bento Gonçalves" only contains it.
    expect(hits[0].name).toBe('Rua Gonçalves Dias')
    expect(hits[1].name).toBe('Rua Bento Gonçalves')
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score)
    }
  })

  test('acerto exato vale mais que erro de digitação', () => {
    const hits = searchStreets('bento', both)
    const typo = searchStreets('bnto', both)
    expect(hits[0].score).toBeGreaterThan(typo[0]?.score ?? 0)
  })

  test('query vazia retorna lista vazia, não o dataset inteiro', () => {
    expect(searchStreets('', both)).toEqual([])
    expect(searchStreets('   ', both)).toEqual([])
  })


  test('respeita o limite', () => {
    expect(searchStreets('r', both, 2).length).toBeLessThanOrEqual(2)
    expect(searchStreets('a', both, 3).length).toBeLessThanOrEqual(3)
  })

  test('"Puente de la Concordia" retorna um resultado em cada país', () => {
    const hits = searchStreets('Puente de la Concordia', both)
    const countries = hits.filter((h) => h.nameNormalized === 'puente de la concordia').map((h) => h.country)
    expect(countries.sort()).toEqual(['BR', 'UY'])
  })

  test('todo resultado carrega city e country, haja ou não duplicidade', () => {
    const hits = [...searchStreets('concordia', both), ...searchStreets('julio', both), ...searchStreets('bento', both)]
    expect(hits.length).toBeGreaterThan(0)
    for (const h of hits) {
      expect(['quarai', 'artigas']).toContain(h.city)
      expect(['BR', 'UY']).toContain(h.country)
      expect(typeof h.score).toBe('number')
    }
    const julio = searchStreets('18 de julio', both)
    expect(julio[0]).toMatchObject({ name: '18 de Julio', city: 'artigas', country: 'UY' })
  })

  test('não altera os datasets recebidos', () => {
    const before = JSON.stringify(both)
    searchStreets('bento', both)
    expect(JSON.stringify(both)).toBe(before)
  })
})

describe('searchStreets nos dados reais', () => {
  const load = (f: string) =>
    JSON.parse(readFileSync(new URL(`../../public/data/${f}`, import.meta.url), 'utf8')) as StreetDataset
  const real = [load('quarai.json'), load('artigas.json')]

  test('encontra as ruas esperadas', () => {
    expect(searchStreets('sao joao', real).map((h) => h.name)).toContain('Avenida São João Batista do Quaraí')
    expect(searchStreets('bento', real).map((h) => h.name)).toContain('Rua Bento Gonçalves')
    expect(searchStreets('gonzalves', real).map((h) => h.name)).toContain('Rua Bento Gonçalves')
    expect(searchStreets('18 de julio', real)[0]).toMatchObject({ name: '18 de Julio', country: 'UY' })
  })

  test('a ponte aparece nos dois países', () => {
    const hits = searchStreets('puente de la concordia', real).filter((h) => h.name === 'Puente de la Concordia')
    expect(hits.map((h) => h.country).sort()).toEqual(['BR', 'UY'])
  })
})
