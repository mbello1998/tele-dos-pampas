import { Archivo, Barlow_Condensed } from 'next/font/google'

/**
 * Display condensado e pesado para manchete, nome de serviço e preço: peso de cartaz, sem virar faroeste.
 * Um único peso e só o subconjunto latino, para custar poucos kB.
 */
export const display = Barlow_Condensed({
  subsets: ['latin'],
  weight: '800',
  variable: '--font-display',
  display: 'swap',
})

/**
 * A fonte da INTERFACE: rótulo, campo, ajuda, linha de preço. Antes daqui o corpo caía na fonte do sistema,
 * e era isso que fazia a tela parecer inacabada num Android.
 *
 * Archivo é grotesca da mesma linhagem da Barlow Condensed, então o par é escolha e não acaso, e aguenta
 * corpo pequeno em tela barata. Três pesos, só latino, servida pelo próprio Next (sem ida ao Google).
 */
export const ui = Archivo({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-ui',
  display: 'swap',
})
