import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { esUY } from '@/lib/i18n/es-UY'
import { detectLocale, LOCALE_COOKIE } from '@/lib/i18n/detect'
import { DEFAULT_LOCALE, isLocale, LOCALES, t, type TranslationKey } from '@/lib/i18n'
import { ptBR } from '@/lib/i18n/pt-BR'

const keys = (d: Record<string, string>) => Object.keys(d).sort()
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('tabelas de tradução', () => {
  test('as duas tabelas de tradução têm exatamente as mesmas chaves', () => {
    const missingInEs = keys(ptBR).filter((k) => !(k in esUY))
    const missingInPt = keys(esUY).filter((k) => !(k in ptBR))
    expect({ missingInEs, missingInPt }).toEqual({ missingInEs: [], missingInPt: [] })
    expect(keys(ptBR).length).toBeGreaterThan(20) // não passa só porque as duas estão vazias
  })

  test('nenhum texto vazio, e os mesmos {marcadores} nos dois idiomas', () => {
    for (const k of keys(ptBR)) {
      expect(ptBR[k as TranslationKey].trim(), `pt-BR ${k}`).not.toBe('')
      expect(esUY[k as TranslationKey].trim(), `es-UY ${k}`).not.toBe('')
      expect(placeholders(esUY[k as TranslationKey]), k).toEqual(placeholders(ptBR[k as TranslationKey]))
    }
  })

  test('o espanhol é de fato espanhol: a maioria dos textos difere do português', () => {
    const same = keys(ptBR).filter((k) => ptBR[k as TranslationKey] === esUY[k as TranslationKey])
    expect(same.length / keys(ptBR).length).toBeLessThan(0.4)
  })

  test('não duplica os textos da landing, que moram em `settings`', () => {
    expect(keys(ptBR).filter((k) => /landing|hero|headline/i.test(k))).toEqual([])
  })

  test('nenhuma chave sobra sem uso: o catálogo é só o que o app consome hoje', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(name) && !p.includes(join('src', 'lib', 'i18n'))) files.push(p)
      }
    }
    walk(resolve(process.cwd(), 'src'))
    const source = files.map((f) => readFileSync(f, 'utf8')).join('\n')
    const unused = keys(ptBR).filter((k) => !source.includes(`'${k}'`) && !source.includes(`"${k}"`))
    expect(unused).toEqual([])
  })
})

describe('t(key, locale)', () => {
  test('devolve o texto do idioma pedido', () => {
    const k = keys(ptBR)[0] as TranslationKey
    expect(t(k, 'pt-BR')).toBe(ptBR[k])
    expect(t(k, 'es-UY')).toBe(esUY[k])
  })

  test('chave desconhecida devolve a própria chave, sem quebrar a página', () => {
    expect(t('nao.existe' as TranslationKey, 'es-UY')).toBe('nao.existe')
  })

  test('idioma desconhecido cai no pt-BR', () => {
    const k = keys(ptBR)[0] as TranslationKey
    expect(t(k, 'fr' as never)).toBe(ptBR[k])
  })

  test('chave herdada do protótipo não é uma tradução', () => {
    expect(t('constructor' as TranslationKey, 'pt-BR')).toBe('constructor')
    expect(t('__proto__' as TranslationKey, 'es-UY')).toBe('__proto__')
  })

  test('LOCALES, DEFAULT_LOCALE e isLocale', () => {
    expect([...LOCALES]).toEqual(['pt-BR', 'es-UY'])
    expect(DEFAULT_LOCALE).toBe('pt-BR')
    expect(isLocale('es-UY')).toBe(true)
    expect(isLocale('en-US')).toBe(false)
    expect(isLocale(undefined)).toBe(false)
    expect(isLocale('__proto__')).toBe(false)
  })
})

describe('detectLocale(Accept-Language)', () => {
  const cases: [string | null | undefined, string, string][] = [
    [null, 'pt-BR', 'sem cabeçalho'],
    ['', 'pt-BR', 'cabeçalho vazio'],
    ['es-UY,es;q=0.9,en;q=0.8', 'es-UY', 'uruguaio'],
    ['es-AR', 'es-UY', 'qualquer espanhol vira es-UY'],
    ['es', 'es-UY', 'espanhol sem região'],
    ['pt-BR,pt;q=0.9,en;q=0.8', 'pt-BR', 'brasileiro'],
    ['pt-PT', 'pt-BR', 'qualquer português vira pt-BR'],
    ['en-US,es;q=0.5,pt;q=0.4', 'es-UY', 'vence o maior q, não o primeiro'],
    ['pt;q=0.4,es;q=0.9', 'es-UY', 'a ordem é pelo q, não pela posição'],
    ['es;q=0, pt', 'pt-BR', 'q=0 significa inaceitável'],
    ['en-US,fr', 'pt-BR', 'nenhum idioma suportado: padrão'],
    ['%%%;;q=x, ;q=1', 'pt-BR', 'lixo não quebra'],
    ['ES-uy', 'es-UY', 'sem diferença de caixa'],
    ['PT-br', 'pt-BR', 'sem diferença de caixa (pt)'],
    ['pt,es', 'pt-BR', 'empate de q: o primeiro'],
    ['es,pt', 'es-UY', 'empate de q: o primeiro (es)'],
    ['*', 'pt-BR', 'curinga não escolhe nada'],
    ['en;q=1,es;q=0.8,pt;q=0.8', 'es-UY', 'empate abaixo do topo: o primeiro dos dois'],
  ]
  test.each(cases)('%j -> %s (%s)', (header, expected) => {
    expect(detectLocale(header)).toBe(expected)
  })

  test('cabeçalho gigante não trava nem quebra', () => {
    expect(detectLocale('x;q=0.1,'.repeat(50_000) + 'es')).toMatch(/^(pt-BR|es-UY)$/)
  })

  test('o nome do cookie é estável', () => {
    expect(LOCALE_COOKIE).toBe('tdp_locale')
  })
})
