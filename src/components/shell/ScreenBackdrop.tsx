// O FUNDO das telas de trabalho (os chamados do motoboy, o chamar-motoboy da loja). Não é o fundo da tela
// inicial: lá a arte é o assunto e tem vídeo; aqui ela é ambiente, e o assunto é a lista ou o formulário.
//
// A regra que manda em tudo: ESTA ARTE NÃO PODE ATRAPALHAR A LEITURA. A tela do motoboy é lida de relance, num
// guidão, no sol. Então a arte entra escura, atrás de um véu firme, e fica PARADA (`fixed`) enquanto o conteúdo
// corre por cima — fundo que rola junto com o texto é o que embaralha a leitura.
//
// DOIS ENQUADRAMENTOS, não um esticado, pela mesma razão do vídeo da tela inicial: a arte 9:16 num monitor vira
// um borrão ampliado, e a 16:9 num celular vira uma tira. Cada uma é uma composição própria, trocada por
// `<picture>` + `media` — arte dirigida, que `next/image` não faz. Como é decoração, um `<img>` simples também
// nos livra de depender do otimizador de imagem no deploy.
//
// Três camadas, de baixo para cima: a arte ancorada no pé (o assunto pintado vive embaixo) e já esmaecida; um
// véu quase opaco no alto, onde fica o cabeçalho, aliviando até o pé; e grão fino, porque degradê escuro em tela
// barata mostra faixas.

/** Grão fino e estático (ruído SVG), o mesmo da tela inicial. */
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E\")"

/**
 * Um degradê em "S" (smoothstep) com muitas paradas, como o da tela inicial: o CSS interpola em linha reta entre
 * paradas, e três ou quatro deixam faixas visíveis num fundo escuro.
 */
function veil(top: number, bottom: number, steps = 9): string {
  const stops = Array.from({ length: steps }, (_, i) => {
    const x = i / (steps - 1)
    const s = x * x * (3 - 2 * x)
    return `rgba(11,15,13,${(top + (bottom - top) * s).toFixed(3)}) ${(x * 100).toFixed(1)}%`
  })
  return `linear-gradient(to bottom, ${stops.join(', ')})`
}

const ART = {
  chamados: { retrato: '/arte/fundo-chamados-retrato-1536.webp', paisagem: '/arte/fundo-chamados-paisagem-1920.webp' },
  loja: { retrato: '/arte/fundo-loja-retrato-1536.webp', paisagem: '/arte/fundo-loja-paisagem-1920.webp' },
  /** Entrar, aguardando, onboarding, perfil: a porteira meio aberta, que é o que essas telas são. */
  conta: { retrato: '/arte/fundo-conta-retrato-1536.webp', paisagem: '/arte/fundo-conta-paisagem-1920.webp' },
  /** Pedir, acompanhar, cadastrar endereço: a ponte à noite, que é o que liga as duas cidades. */
  pedido: { retrato: '/arte/fundo-pedido-retrato-1536.webp', paisagem: '/arte/fundo-pedido-paisagem-1920.webp' },
  /** Institucional (/sobre, /es): a mesma arte da tela inicial, de propósito — é a mesma casa. */
  pampa: { retrato: '/arte/pampa-fundo-1536.webp', paisagem: '/arte/pampa-fundo-1536.webp' },
} as const

export type BackdropName = keyof typeof ART

export function ScreenBackdrop({
  name,
  /** Quanto da arte passa pelo véu. Baixo de propósito: ela é ambiente. */
  opacity = 0.42,
}: {
  name: BackdropName
  opacity?: number
}) {
  const art = ART[name]
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-noite">
      <picture>
        <source media="(min-width: 768px)" srcSet={art.paisagem} />
        <img
          src={art.retrato}
          alt=""
          decoding="async"
          loading="lazy"
          className="h-full w-full object-cover object-bottom"
          style={{ opacity }}
        />
      </picture>
      <div className="absolute inset-0" style={{ backgroundImage: veil(0.92, 0.34) }} />
      <div
        className="absolute inset-0 opacity-[0.05] mix-blend-overlay"
        style={{ backgroundImage: GRAIN, backgroundRepeat: 'repeat' }}
      />
    </div>
  )
}
