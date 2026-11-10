import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        noite: '#0B0F0D',
        sol: '#F2A516',
        brasa: '#D9452B',
        rio: '#2E7D8C',
        campo: '#1F4D3A',
      },
    },
  },
  plugins: [],
}

export default config
