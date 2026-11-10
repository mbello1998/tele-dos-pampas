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
