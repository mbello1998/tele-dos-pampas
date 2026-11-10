// tests/unit/tokens.test.ts
import tokens from '../../src/styles/tokens.css?raw'

// Cada nome de token fica amarrado ao seu hex. `toContain` sobre o arquivo todo
// passaria mesmo com sol e brasa trocados, porque os dois valores continuariam lá.
const cores: Record<string, string> = {
  noite: '#0B0F0D',
  sol: '#F2A516',
  brasa: '#D9452B',
  rio: '#2E7D8C',
  campo: '#1F4D3A',
}

describe('tokens de cor da spec', () => {
  for (const [nome, hex] of Object.entries(cores)) {
    test(`--color-${nome} vale ${hex}`, () => {
      expect(tokens).toMatch(new RegExp(String.raw`--color-${nome}:\s*${hex}\s*;`, 'i'))
    })
  }
})

test('preço usa números tabulares dentro da regra .preco', () => {
  // O corpo da regra, sem comentários: um `tabular-nums` num comentário não vale.
  const semComentarios = tokens.replace(/\/\*[\s\S]*?\*\//g, '')
  const regra = semComentarios.match(/\.preco\s*\{([^}]*)\}/)
  expect(regra, 'regra .preco não encontrada').not.toBeNull()
  expect(regra![1]).toMatch(/font-variant-numeric:\s*tabular-nums\s*;/)
})
