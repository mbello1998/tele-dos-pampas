import { defineConfig } from '@playwright/test'

// Os specs rodam contra o build de produção: o orçamento de JS só faz sentido sobre ele.
//   npm run build && npx playwright test
const PORT = 3199

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  // Explícito: sem isso o navegador herda a preferência do sistema operacional (com os efeitos de
  // animação do Windows desligados, tudo rodaria como reduced-motion e os testes de movimento
  // passariam sem exercitar movimento nenhum).
  use: { baseURL: `http://localhost:${PORT}`, reducedMotion: 'no-preference' },
  webServer: {
    command: `npm run start -- -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false, // nunca reaproveitar: um servidor velho na porta testaria um build velho
    timeout: 60_000,
  },
})
