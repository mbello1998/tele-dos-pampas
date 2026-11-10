import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // O tsconfig usa jsx: preserve (quem compila é o Next); no Vitest o JSX precisa ser transformado.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    globals: true,
    environment: 'node',
    // Vitest stubs .css imports to an empty string by default, which also
    // empties `?raw` imports. Let CSS through so tokens.css?raw returns its source.
    css: { include: [/\.css/] },
    // Dois projetos: tests/db roda SEM paralelismo entre arquivos. Esses testes falam com o mesmo banco real
    // (compartilhado) e alguns confirmam dados (a suíte de concorrência) enquanto outros comparam contagens
    // entre instruções (rls.test.ts): em paralelo, um commit alheio faria outro arquivo falhar sem culpa do
    // código. Eles já se serializam na rede, então o custo é desprezível. O resto da suíte segue em paralelo.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
          exclude: ['tests/db/**', '**/node_modules/**'],
        },
      },
      {
        extends: true,
        test: { name: 'db', include: ['tests/db/**/*.test.ts'], fileParallelism: false },
      },
    ],
  },
})
