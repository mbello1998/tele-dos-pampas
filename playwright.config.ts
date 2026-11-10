// @ts-nocheck -- `@playwright/test` ainda não é dependência do projeto (a Tarefa 14 só podia
// acrescentar gsap e lenis). Quando for instalado, remova esta linha para voltar a checar tipos.
import { defineConfig } from '@playwright/test'

// Os specs rodam contra o build de produção: o orçamento de JS só faz sentido sobre ele.
//   npm run build && npx playwright test
const PORT = 3100

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: `npm run start -- -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
