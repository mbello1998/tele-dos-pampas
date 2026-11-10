import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Vitest stubs .css imports to an empty string by default, which also
    // empties `?raw` imports. Let CSS through so tokens.css?raw returns its source.
    css: { include: [/\.css/] },
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
})
