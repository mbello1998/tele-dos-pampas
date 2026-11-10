'use client'

// "Procurando um motoboy": um radar em SVG, sem vídeo (o vídeo Remotion é de uma fatia posterior). Uma
// varredura gira sobre a malha REAL de ruas das duas cidades e anéis pulsam a partir do centro.
//
// Regras de movimento (as mesmas da landing, ver src/lib/motion/presets.ts):
//   - só `transform` (rotation, scale) e `opacity`;
//   - a única exceção é o desenho da malha, que usa o preset `presets.gridStroke` (o nome da propriedade
//     mora só ali, e tests/unit/motion.test.tsx confere que nenhum outro preset a usa);
//   - GSAP só entra por `loadMotion()`. Com prefers-reduced-motion, economia de dados ou rede 2G ele nem é
//     baixado: o que sobra é o SVG parado e o texto de estado, que é o conteúdo de verdade.
// A malha é a versão simplificada de 10 kB feita para animação, nunca os datasets completos (225 e 400 kB).
import { useEffect, useRef, useState } from 'react'
import { GRID_VIEWBOX, type Mesh } from '@/lib/motion/grid-geometry'
import { loadMotion, motionAllowed } from '@/lib/motion/gsap'
import { presets } from '@/lib/motion/presets'

const MESH_URL = '/data/grid-simplified.json'
const DASH = 100 // pathLength dos traços: 100 = escondido, 0 = desenhado (ver presets.gridStroke)
const C = GRID_VIEWBOX / 2

/**
 * Liga o movimento do radar dentro de `root`. Devolve a função que desfaz tudo. Sem movimento permitido não
 * baixa nada e devolve uma função vazia.
 */
export async function playRadar(root: Element): Promise<() => void> {
  const motion = await loadMotion()
  if (!motion) return () => {}
  const { gsap } = motion

  const ctx = gsap.context(() => {
    const sweep = root.querySelector('[data-sweep]')
    const rings = root.querySelectorAll('[data-ring]')
    const core = root.querySelector('[data-core]')
    const meshQuarai = root.querySelector('[data-mesh-quarai]')
    const meshArtigas = root.querySelector('[data-mesh-artigas]')

    // A rua se desenhando: a propriedade vem do preset, não daqui.
    if (meshQuarai) gsap.fromTo(meshQuarai, presets.gridStroke.from, { ...presets.gridStroke.to, duration: 2.4 })
    if (meshArtigas) gsap.fromTo(meshArtigas, presets.gridStroke.from, { ...presets.gridStroke.to, duration: 2.4, delay: 0.9 })

    // A varredura gira em volta do centro da malha. rotation = transform.
    if (sweep) gsap.to(sweep, { rotation: 360, svgOrigin: `${C} ${C}`, duration: 3.6, ease: 'none', repeat: -1 })
    // Anéis que nascem no centro, crescem e somem. scale + opacity.
    rings.forEach((ring, i) => {
      gsap.fromTo(
        ring,
        { scale: 0.15, opacity: 0.55, svgOrigin: `${C} ${C}` },
        { scale: 1, opacity: 0, svgOrigin: `${C} ${C}`, duration: 3.6, ease: 'power1.out', repeat: -1, delay: i * 1.2 },
      )
    })
    if (core) gsap.fromTo(core, { scale: 1, svgOrigin: `${C} ${C}` }, { scale: 1.35, svgOrigin: `${C} ${C}`, duration: 0.9, ease: 'sine.inOut', repeat: -1, yoyo: true })
  }, root)

  return () => ctx.revert()
}

type MeshState = { status: 'pending' } | { status: 'failed' } | { status: 'ready'; mesh: Mesh }

type Props = {
  /** Texto de estado, lido por leitores de tela. É o conteúdo; o SVG é enfeite. */
  label: string
  /** Frase de apoio sob o estado (ex.: "costuma levar poucos minutos"). */
  hint?: string
}

// Estado inicial escondido: o `from` do preset (a propriedade não é escrita fora do preset).
const hiddenStroke = { strokeDasharray: DASH, ...presets.gridStroke.from }

export function SearchingRadar({ label, hint }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<MeshState>({ status: 'pending' })

  // 1) A malha só é buscada se o movimento é permitido: senão ela nem seria desenhada.
  useEffect(() => {
    if (!motionAllowed()) {
      setState({ status: 'failed' })
      return
    }
    let cancelled = false
    fetch(MESH_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`malha: HTTP ${res.status}`)
        return res.json() as Promise<Mesh>
      })
      .then((mesh) => !cancelled && setState({ status: 'ready', mesh }))
      .catch(() => !cancelled && setState({ status: 'failed' })) // sem malha, o radar segue só com a varredura
    return () => {
      cancelled = true
    }
  }, [])

  // 2) Com a malha resolvida (ou falha), liga o movimento. Antes disso nada se mexe: evita reiniciar a
  //    varredura quando a malha chega.
  useEffect(() => {
    const root = rootRef.current
    if (!root || state.status === 'pending') return
    let cancelled = false
    let stop: (() => void) | undefined
    void playRadar(root).then((undo) => {
      if (cancelled) undo()
      else stop = undo
    })
    return () => {
      cancelled = true
      stop?.()
    }
  }, [state])

  const mesh = state.status === 'ready' ? state.mesh : null

  return (
    <div ref={rootRef} className="flex flex-col items-center gap-4 text-center" data-searching-radar>
      <svg viewBox={`0 0 ${GRID_VIEWBOX} ${GRID_VIEWBOX}`} aria-hidden="true" className="aspect-square w-full max-w-[22rem]">
        <defs>
          <radialGradient id="radar-fade" cx="50%" cy="50%" r="50%">
            <stop offset="55%" stopColor="#0B0F0D" stopOpacity="0" />
            <stop offset="100%" stopColor="#0B0F0D" stopOpacity="1" />
          </radialGradient>
          <linearGradient id="radar-sweep" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#F2A516" stopOpacity="0" />
            <stop offset="100%" stopColor="#F2A516" stopOpacity="0.5" />
          </linearGradient>
        </defs>

        {mesh && (
          <g>
            <path
              data-mesh-quarai
              d={mesh.paths.quarai}
              pathLength={DASH}
              fill="none"
              stroke="#F2A516"
              strokeOpacity={0.55}
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={hiddenStroke}
            />
            <path
              data-mesh-artigas
              d={mesh.paths.artigas}
              pathLength={DASH}
              fill="none"
              stroke="#2E7D8C"
              strokeOpacity={0.7}
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              style={hiddenStroke}
            />
          </g>
        )}

        {/* Anéis parados são o estado de repouso: aparecem assim com movimento reduzido. */}
        <circle cx={C} cy={C} r={150} fill="none" stroke="#F2A516" strokeOpacity={0.25} strokeWidth={2} />
        <circle cx={C} cy={C} r={290} fill="none" stroke="#F2A516" strokeOpacity={0.18} strokeWidth={2} />
        <circle cx={C} cy={C} r={430} fill="none" stroke="#F2A516" strokeOpacity={0.12} strokeWidth={2} />
        {[0, 1, 2].map((i) => (
          <circle key={i} data-ring cx={C} cy={C} r={430} fill="none" stroke="#F2A516" strokeWidth={3} opacity={0} />
        ))}

        {/* Cunha da varredura de 60°, com o gume na direita, girada por transform. */}
        <path data-sweep d={`M${C} ${C} L${C + 430} ${C} A430 430 0 0 0 ${C + 430 * Math.cos(Math.PI / 3)} ${C - 430 * Math.sin(Math.PI / 3)} Z`} fill="url(#radar-sweep)" />
        <circle data-core cx={C} cy={C} r={16} fill="#F2A516" />
        <circle cx={C} cy={C} r={GRID_VIEWBOX / 2} fill="url(#radar-fade)" />
      </svg>

      <p role="status" className="font-[family-name:var(--font-display)] text-xl font-extrabold uppercase tracking-wide text-sol">
        {label}
      </p>
      {hint && <p className="max-w-xs text-sm text-white/60">{hint}</p>}
    </div>
  )
}
