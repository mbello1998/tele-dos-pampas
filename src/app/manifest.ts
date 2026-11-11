import type { MetadataRoute } from 'next'

/**
 * Manifesto do app. Existe por um motivo prático, não por completude: o motoboy
 * instala na tela inicial e abre direto, em tela cheia, sem barra de navegador —
 * é a diferença entre "um site que eu abro" e "o app do trabalho".
 *
 * `display: standalone` + `start_url: '/'` levam direto à tela de pedido.
 * O ícone maskable existe porque o Android recorta as bordas: sem ele, o sol
 * fica cortado dentro do círculo do launcher.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Tele dos Pampas',
    short_name: 'Tele Pampas',
    description:
      'Mototáxi, encomendas e tele-entrega em Quaraí e Artigas. Peça do seu lado do rio, do outro, ou atravessando a ponte.',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0B0F0D',
    theme_color: '#0B0F0D',
    categories: ['travel', 'navigation', 'food'],
    lang: 'pt-BR',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
