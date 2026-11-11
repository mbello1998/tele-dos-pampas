'use client'

// O FUNDO da tela de pedido, antes de qualquer busca: a arte do pampa (o poster) e, por cima dela, o mesmo
// desenho em movimento — as duas malhas de Quaraí e Artigas se acendendo, a ponte, o rastro âmbar, o sol respirando.
// O vídeo é feito com Remotion a partir da malha real (video/, scripts/video/render.ts) e vive em public/video/.
//
// Como ele se comporta, e por quê:
//   1. o que chega com o HTML é só a ARTE ESTÁTICA (um <Image> com prioridade). É o primeiro quadro, é o que se vê
//      sem JS, com prefers-reduced-motion, com economia de dados e em rede 2G — e nesses casos NADA mais é baixado;
//   2. a decisão de "movimento liberado" é a de sempre (`motionAllowed()`, a mesma do GSAP e do resto do app), não
//      uma segunda regra. O <video> nem entra no DOM antes disso, então não há `<source>` que o navegador possa buscar;
//   3. mesmo liberado, ele só entra depois do evento `load` e de um momento ocioso: o fundo não disputa rede com o
//      que a pessoa veio fazer;
//   4. entra transparente e só aparece (fade) quando o navegador de fato começou a tocar; se falhar, a arte fica;
//   5. pausa fora da tela e com a aba escondida: bateria de Android de entrada não é para enfeite.
//
// Dois enquadramentos: retrato (celular, 9:16) e paisagem (>= 768 px de largura, 16:9). Cada um é uma composição
// própria, não um vídeo esticado.
import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { motionAllowed } from '@/lib/motion/gsap'

const VIDEO = {
  retrato: { webm: '/video/pampa-retrato.webm', mp4: '/video/pampa-retrato.mp4' },
  paisagem: { webm: '/video/pampa-paisagem.webm', mp4: '/video/pampa-paisagem.mp4' },
}
/**
 * Um degradê em "S" (smoothstep) com muitas paradas. O CSS interpola em linha reta entre paradas, então com três
 * ou quatro um fundo escuro mostra os cantos como faixas; com oito a curva fica contínua. `from`/`to` em % da
 * altura da caixa, `peak` é a opacidade final.
 */
function easedScrim(from: number, to: number, peak: number, steps = 9): string {
  const stops = Array.from({ length: steps }, (_, i) => {
    const x = i / (steps - 1)
    const s = x * x * (3 - 2 * x)
    return `rgba(11,15,13,${(peak * s).toFixed(3)}) ${(from + (to - from) * x).toFixed(1)}%`
  })
  return `linear-gradient(to bottom, rgba(11,15,13,0) 0%, ${stops.join(', ')}, rgba(11,15,13,${peak}) 100%)`
}
/** O véu da janela inteira: leve no céu, firme no campo. Começa em 0 e sobe em S até 0,72 no pé. */
const FULL_SCRIM = easedScrim(0, 100, 0.72)
/** Grão fino e estático (ruído SVG): quebra as faixas que um degradê escuro mostra em tela barata. */
const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E\")"

const WIDE = '(min-width: 768px)'
const REDUCED = '(prefers-reduced-motion: reduce)'

type Props = {
  /** A arte grande, para o <Image>. */
  artSrc: string
  /** O poster do <video>: a mesma arte em 768 px. */
  posterSrc: string
}

export function IdleBackdrop({ artSrc, posterSrc }: Props) {
  const [format, setFormat] = useState<keyof typeof VIDEO | null>(null)
  const [playing, setPlaying] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)

  /** Sem vídeo, a arte já está lá. Tira o elemento para o navegador parar de tentar. */
  const giveUp = () => {
    setFormat(null)
    setPlaying(false)
  }

  // 1. Decide se o vídeo entra, e quando.
  useEffect(() => {
    if (!motionAllowed()) return // reduced-motion, economia de dados ou 2G: fica a arte, e nada é baixado
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const enter = () => {
      if (cancelled || !motionAllowed()) return
      setFormat(window.matchMedia(WIDE).matches ? 'paisagem' : 'retrato')
    }
    const whenIdle = () => {
      const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback
      if (ric) ric(enter, { timeout: 2500 })
      else timer = setTimeout(enter, 800)
    }
    if (document.readyState === 'complete') whenIdle()
    else window.addEventListener('load', whenIdle, { once: true })

    // Se a pessoa ligar "reduzir movimento" no meio da sessão, o vídeo sai e fica a arte.
    const mq = window.matchMedia(REDUCED)
    const onChange = () => {
      if (mq.matches) {
        setFormat(null)
        setPlaying(false)
      }
    }
    mq.addEventListener('change', onChange)
    return () => {
      cancelled = true
      clearTimeout(timer)
      window.removeEventListener('load', whenIdle)
      mq.removeEventListener('change', onChange)
    }
  }, [])

  // 2. Pausa quando não é visto: fora da tela (a página rolou) ou aba escondida.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let visible = true
    const sync = () => {
      if (visible && !document.hidden) void video.play().catch(() => {})
      else video.pause()
    }
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      sync()
    })
    io.observe(video)
    document.addEventListener('visibilitychange', sync)
    return () => {
      io.disconnect()
      document.removeEventListener('visibilitychange', sync)
    }
  }, [format])

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-noite">
      {/* TELA CHEIA E PARADO. Antes isto era um pôster de altura fixa no alto da página: o vídeo acabava no meio
          e o resto da tela virava preto. Agora o quadro é a janela inteira, fixo, e o formulário passa na frente
          enquanto rola — o fundo nunca termina. Os dois enquadramentos continuam: retrato no celular, paisagem
          de 768 px para cima, cada um uma composição própria e não um vídeo esticado. */}
      <div className="absolute inset-0">
        <Image
          src={artSrc}
          alt=""
          fill
          priority
          sizes="100vw"
          className="object-cover object-center"
        />

        {format && (
          <video
            ref={videoRef}
            key={format}
            className={`absolute inset-0 size-full object-cover transition-opacity duration-[1400ms] ease-out ${
              playing ? 'opacity-100' : 'opacity-0'
            }`}
            poster={posterSrc}
            muted
            loop
            autoPlay
            playsInline
            preload="metadata"
            disablePictureInPicture
            onPlaying={() => setPlaying(true)}
            onError={giveUp}
          >
            {/* WebM (VP9) primeiro, MP4 (H.264) depois: o navegador toca o primeiro que sabe tocar. Só o erro do
                ÚLTIMO <source> quer dizer "nenhum serve" — o do primeiro é o Safari passando para o MP4. */}
            <source src={VIDEO[format].webm} type='video/webm; codecs="vp9"' />
            <source src={VIDEO[format].mp4} type="video/mp4" onError={giveUp} />
          </video>
        )}

        {/* O VÉU. Agora o conteúdo passa por cima do quadro inteiro, não só do pé dele, então ele cobre a janela
            toda: leve no alto, onde mora a manchete sobre o céu (que já é escuro), e firme embaixo, onde o
            formulário precisa ser lido sobre o campo claro. É o mesmo S de antes — com poucas paradas um
            degradê escuro mostra faixas. Ele também abafa a linha do horizonte, que era a emenda dura de que o
            dono reclamou: sem a caixa de altura fixa não dá para mirar nela, e o véu resolve por cobertura. */}
        <div className="absolute inset-0" style={{ backgroundImage: FULL_SCRIM }} />
        <div className="absolute inset-0 opacity-[0.05] mix-blend-overlay" style={{ backgroundImage: GRAIN }} />
      </div>
    </div>
  )
}
