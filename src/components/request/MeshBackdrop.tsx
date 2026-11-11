'use client'

// A textura atrás do formulário: a MALHA REAL de Quaraí e Artigas, as duas tramas separadas pelo rio e costuradas
// pela ponte. Vem do mesmo dataset que alimenta a busca de endereço, reduzida em build para
// public/data/grid-simplified.json (27 kB crus, ~10 kB comprimidos).
//
// Como ela se comporta, e por quê:
//   1. o que chega com o HTML é o POSTER estático (SVG de 28 kB). É o que se vê sem JS, com
//      prefers-reduced-motion e com economia de dados ligada;
//   2. só se o movimento for permitido, a malha é buscada e DESENHADA por cima, com `stroke-dashoffset` —
//      a única exceção à regra "só transform e opacity", porque é o que faz a rua se construir;
//   3. depois de desenhada, ela PARA. Nada de respiração infinita: repintar um SVG de milhares de vértices a
//      cada quadro, para sempre, é bateria e CPU de um Android de entrada gastas em enfeite. O que continua é
//      um ponto de 9 px atravessando a ponte — `transform` num nó minúsculo, que é barato.
//
// Nenhum GSAP aqui: a animação é CSS (src/styles/motion.css), então esta rota não baixa biblioteca de
// movimento nenhuma, e com reduced-motion nada é buscado.
import { useEffect, useState } from 'react'
import { GRID_VIEWBOX, type Mesh } from '@/lib/motion/grid-geometry'
import { motionAllowed } from '@/lib/motion/gsap'

const MESH_URL = '/data/grid-simplified.json'

export function MeshBackdrop({ posterSrc }: { posterSrc: string }) {
  const [mesh, setMesh] = useState<Mesh | null>(null)

  useEffect(() => {
    if (!motionAllowed()) return // reduced-motion ou economia de dados: fica o poster, e nada é baixado
    let cancelled = false
    // Depois da pintura: a malha é fundo, e não disputa rede com o que a pessoa veio fazer.
    const id = setTimeout(() => {
      fetch(MESH_URL)
        .then((r) => (r.ok ? r.json() : null))
        .then((next: Mesh | null) => {
          if (!cancelled && next?.bridge) setMesh(next)
        })
        .catch(() => {
          /* sem malha, o poster já mostra o desenho */
        })
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [])

  const bridge = mesh?.bridge ?? null

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute left-1/2 top-0 aspect-square w-[max(100vw,36rem)] -translate-x-1/2">
        {/* eslint-disable-next-line @next/next/no-img-element -- SVG estático, não há o que otimizar */}
        <img
          src={posterSrc}
          alt=""
          width={GRID_VIEWBOX}
          height={GRID_VIEWBOX}
          decoding="async"
          className={`absolute inset-0 h-full w-full transition-opacity duration-700 ${mesh ? 'opacity-[0.04]' : 'opacity-[0.10]'}`}
        />

        {mesh && bridge && (
          <svg viewBox={`0 0 ${GRID_VIEWBOX} ${GRID_VIEWBOX}`} className="absolute inset-0 h-full w-full">
            <path d={mesh.river} fill="none" stroke="currentColor" strokeOpacity={0.35} strokeWidth={30} strokeLinecap="round" className="malha-rio text-rio" />
            <path
              d={mesh.paths.quarai}
              pathLength={100}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeOpacity={0.3}
              className="malha-traco text-sol"
            />
            <path
              d={mesh.paths.artigas}
              pathLength={100}
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeOpacity={0.26}
              className="malha-traco text-rio"
              style={{ '--atraso': '1.1s' } as React.CSSProperties}
            />
            <path
              d={`M${bridge.quarai.x} ${bridge.quarai.y}L${bridge.artigas.x} ${bridge.artigas.y}`}
              pathLength={100}
              fill="none"
              stroke="currentColor"
              strokeWidth={5}
              strokeLinecap="round"
              strokeOpacity={0.4}
              className="malha-traco text-white"
              style={{ '--atraso': '2.6s', animationDuration: '0.7s' } as React.CSSProperties}
            />
            <circle
              cx={bridge.quarai.x}
              cy={bridge.quarai.y}
              r={9}
              fill="currentColor"
              className="malha-moto text-sol"
              style={
                {
                  '--dx': `${bridge.artigas.x - bridge.quarai.x}`,
                  '--dy': `${bridge.artigas.y - bridge.quarai.y}`,
                } as React.CSSProperties
              }
            />
          </svg>
        )}
      </div>

      {/* Véu: a malha fica no escuro e nunca disputa leitura com os campos. Gradiente estático, sem repintura. */}
      <div className="absolute inset-0 bg-[radial-gradient(120%_80%_at_50%_0%,rgba(11,15,13,0.80)_0%,rgba(11,15,13,0.9)_55%,var(--color-noite)_100%)]" />
    </div>
  )
}
