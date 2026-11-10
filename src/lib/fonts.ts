import { Barlow_Condensed } from 'next/font/google'

/**
 * Display condensado e pesado para manchete: peso de cartaz, sem virar faroeste. Um único peso e
 * só o subconjunto latino, para custar poucos kB. O corpo do texto usa a fonte do sistema.
 */
export const display = Barlow_Condensed({
  subsets: ['latin'],
  weight: '800',
  variable: '--font-display',
  display: 'swap',
})
