// O loop do fundo da tela de pedido: as duas malhas se acendendo, o rio no meio, a ponte, o rastro âmbar e o sol
// respirando. SVG puro, sem texto: a manchete é HTML ao vivo por cima (tradução e acessibilidade).
//
// Costura: no quadro 0 e no quadro final tudo está no mesmo estado — as ruas em "repouso" (um traço fraco, sempre
// presente, para o primeiro quadro parecer a arte pintada), nenhum realce aceso, o rastro apagado, o sol na mesma
// fase. Tudo o que se acende apaga na janela T.fade, ANTES do fim, e a respiração do sol é um seno de período
// exato = duração do loop. Por isso não há corte.
import React, { useMemo } from 'react'
import { useCurrentFrame, useVideoConfig } from 'remotion'
import {
  FPS,
  LAYOUTS,
  LOOP_SECONDS,
  T,
  buildRoute,
  cityRuns,
  easeOut,
  makeProjector,
  pointAlong,
  polyLength,
  range,
  riverPoints,
  smooth,
  toD,
  type FormatName,
  type Mesh,
  type Palette,
  type Pt,
} from './scene'

export type LoopProps = { mesh: Mesh; palette: Palette; format: FormatName }

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))

export const PampaLoop: React.FC<LoopProps> = ({ mesh, palette, format }) => {
  const frame = useCurrentFrame()
  const { width, height } = useVideoConfig()
  const L = LAYOUTS[format]
  const t = frame / FPS

  // Tudo que depende só do dado e do formato, uma vez.
  const scene = useMemo(() => {
    const proj = makeProjector(mesh, L)
    const quarai = cityRuns(mesh.paths.quarai, proj, L)
    const artigas = cityRuns(mesh.paths.artigas, proj, L)
    const route = buildRoute(mesh, { quarai: 360, artigas: 300 }).map(proj.point)
    const bridge = [proj.point(mesh.bridge.quarai), proj.point(mesh.bridge.artigas)]
    const bridgeScale = proj.scaleAt(mesh.bridge.quarai)

    // Rio: faixa com largura proporcional à escala, do horizonte até o pé do quadro.
    const raw = riverPoints(mesh.river).filter((p) => {
      const d = proj.depth(p)
      return d > -0.4 && d < 1.45
    })
    const centre = raw.map(proj.point)
    const widths = raw.map((p) => 46 * proj.scaleAt(p))
    const side = (sign: number, grow = 0) =>
      centre.map((c, i) => {
        const a = centre[Math.max(0, i - 1)]
        const b = centre[Math.min(centre.length - 1, i + 1)]
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
        const nx = -(b.y - a.y) / len
        const ny = (b.x - a.x) / len
        const w = (widths[i] + grow * 2) / 2
        return { x: c.x + nx * w * sign, y: c.y + ny * w * sign }
      })
    const ribbon = (grow: number) => {
      const l = side(1, grow)
      const r = side(-1, grow).reverse()
      return `${toD([...l, ...r])}Z`
    }
    return {
      quarai,
      artigas,
      route,
      routeLength: polyLength(route),
      bridge,
      bridgeScale,
      bank: ribbon(14),
      water: ribbon(0),
      centreLine: toD(centre),
      baseQuarai: quarai.map((r) => r.d).join(''),
      baseArtigas: artigas.map((r) => r.d).join(''),
    }
  }, [mesh, L])

  const phase = (2 * Math.PI * t) / LOOP_SECONDS
  const breath = Math.sin(phase) // período exato do loop
  const sunR = L.sunR * (1 + 0.018 * breath)
  const glow = 0.2 + 0.07 * breath
  const fade = smooth(range(t, T.fade)) // 0 -> 1 no final: apaga tudo o que foi aceso
  const lit = 1 - fade

  const hi = 0.5 // opacidade de uma rua no instante em que se desenha
  const settled = 0.3 // depois de desenhada, antes do apagar
  const rest = 0.13 // sempre presente

  const streetLayer = (runs: typeof scene.quarai, window: readonly [number, number], opacity: number) => {
    const u = range(t, window)
    return runs.map((r, i) => {
      const local = (u - r.start) / r.grow
      if (local <= 0) return null
      const p = easeOut(clamp01(local))
      const flash = local < 1 ? 1 : clamp01(1 - (local - 1) / 0.6)
      const o = (settled + flash * (hi - settled)) * lit * opacity
      if (o < 0.004) return null
      return (
        <path
          key={i}
          d={r.d}
          fill="none"
          stroke={palette.sol}
          strokeOpacity={o}
          strokeWidth={1.3 + 1.4 * r.width}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={`${r.length} ${r.length}`}
          strokeDashoffset={r.length * (1 - p)}
        />
      )
    })
  }

  const bridgeP = easeOut(clamp01(range(t, T.bridge)))
  const trailP = smooth(clamp01(range(t, T.trail)))
  const head: Pt = pointAlong(scene.route, scene.routeLength * trailP)
  const trailOn = trailP > 0.001 && lit > 0.002

  return (
    <svg width={width} height={height} viewBox={`0 0 ${L.width} ${L.height}`} style={{ display: 'block', background: palette.noite }}>
      <defs>
        <radialGradient id="ceu" cx={L.sunX} cy={L.horizon} r={L.height * 0.5} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={palette.sol} stopOpacity={glow} />
          <stop offset="0.35" stopColor={palette.brasa} stopOpacity={glow * 0.28} />
          <stop offset="1" stopColor={palette.noite} stopOpacity={0} />
        </radialGradient>
        <linearGradient id="campo" x1="0" y1={L.horizon} x2="0" y2={L.height} gradientUnits="userSpaceOnUse">
          {/* O chão começa SEM cor no horizonte e ganha corpo devagar: o degrau seco entre céu e campo era
              justamente o que cortava a tela atrás da manchete. */}
          <stop offset="0" stopColor={palette.campo} stopOpacity={0} />
          <stop offset="0.1" stopColor={palette.campo} stopOpacity={0.3} />
          <stop offset="0.45" stopColor={palette.campo} stopOpacity={0.2} />
          <stop offset="1" stopColor={palette.noite} stopOpacity={0} />
        </linearGradient>
        {/* Bruma: tudo o que está no chão (rio, ruas, ponte, rastro) some no horizonte e ganha nitidez ao chegar
            perto — perspectiva atmosférica. Sem isso a malha de longe encostava na linha do horizonte e na manchete. */}
        <linearGradient id="brumaGrad" x1="0" y1={L.horizon} x2="0" y2={L.horizon + (L.height - L.horizon) * 0.42} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity={0} />
          <stop offset="0.25" stopColor="#fff" stopOpacity={0.12} />
          <stop offset="0.55" stopColor="#fff" stopOpacity={0.5} />
          <stop offset="0.8" stopColor="#fff" stopOpacity={0.85} />
          <stop offset="1" stopColor="#fff" stopOpacity={1} />
        </linearGradient>
        <mask id="bruma" maskUnits="userSpaceOnUse" x={0} y={0} width={L.width} height={L.height}>
          <rect x={0} y={L.horizon} width={L.width} height={L.height - L.horizon} fill="url(#brumaGrad)" />
        </mask>
        <linearGradient id="pe" x1="0" y1={L.height * 0.62} x2="0" y2={L.height} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={palette.noite} stopOpacity={0} />
          <stop offset="1" stopColor={palette.noite} stopOpacity={1} />
        </linearGradient>
        <linearGradient id="solFade" x1="0" y1={L.horizon - L.sunR * 0.5} x2="0" y2={L.horizon + 4} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity={1} />
          <stop offset="0.6" stopColor="#fff" stopOpacity={0.8} />
          <stop offset="0.85" stopColor="#fff" stopOpacity={0.35} />
          <stop offset="1" stopColor="#fff" stopOpacity={0} />
        </linearGradient>
        <mask id="solMask" maskUnits="userSpaceOnUse" x={0} y={0} width={L.width} height={L.height}>
          <rect x={0} y={0} width={L.width} height={L.horizon + 8} fill="url(#solFade)" />
        </mask>
        <linearGradient id="faixa" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={palette.sol} stopOpacity={0} />
          <stop offset="0.5" stopColor={palette.sol} stopOpacity={0.16} />
          <stop offset="1" stopColor={palette.sol} stopOpacity={0} />
        </linearGradient>
      </defs>

      <rect width={L.width} height={L.height} fill={palette.noite} />
      <rect width={L.width} height={L.height} fill="url(#ceu)" />

      {/* O sol. Sem corte seco no horizonte: o disco se dissolve na bruma do fim do dia, e em vez de uma linha
          fina há uma faixa de luz difusa. A linha dura atravessava a manchete e era a "diferença brusca" da tela. */}
      <g mask="url(#solMask)">
        <circle cx={L.sunX} cy={L.horizon - sunR * 0.4} r={sunR} fill={palette.sol} />
      </g>
      <rect x={0} y={L.horizon} width={L.width} height={L.height - L.horizon} fill="url(#campo)" />
      <rect x={0} y={L.horizon - 70} width={L.width} height={140} fill="url(#faixa)" opacity={0.85 + 0.15 * breath} />

      <g mask="url(#bruma)">
        {/* Rio. */}
        <path d={scene.bank} fill={palette.campo} opacity={0.55} />
        <path d={scene.water} fill={palette.rio} opacity={0.62} />
        <path
          d={scene.centreLine}
          fill="none"
          stroke={palette.rio}
          strokeOpacity={0.5}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray="2 34"
          // anda exatamente um período de pontilhado por volta: a cintilação do rio também fecha o loop
          strokeDashoffset={-36 * (t / LOOP_SECONDS)}
        />

        {/* Ruas em repouso: o traço que o primeiro quadro mostra. */}
        <path d={scene.baseQuarai} fill="none" stroke={palette.sol} strokeOpacity={rest} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        <path d={scene.baseArtigas} fill="none" stroke={palette.sol} strokeOpacity={rest * 0.9} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

        {/* Realce: cada rua se desenha, na ordem do dado (da ponte para fora). */}
        <g>{streetLayer(scene.quarai, T.quarai, 1)}</g>
        <g>{streetLayer(scene.artigas, T.artigas, 0.88)}</g>

        {/* Ponte. */}
        {bridgeP > 0.001 && lit > 0.002 && (
          <g opacity={lit}>
            <path
              d={toD(scene.bridge)}
              stroke={palette.sol}
              strokeOpacity={0.3}
              strokeWidth={14 * scene.bridgeScale}
              strokeLinecap="round"
              fill="none"
              strokeDasharray="1000 1000"
              strokeDashoffset={1000 * (1 - bridgeP)}
              pathLength={1000}
            />
            <path
              d={toD(scene.bridge)}
              stroke={palette.sol}
              strokeOpacity={0.95}
              strokeWidth={4.5 * scene.bridgeScale}
              strokeLinecap="round"
              fill="none"
              strokeDasharray="1000 1000"
              strokeDashoffset={1000 * (1 - bridgeP)}
              pathLength={1000}
            />
          </g>
        )}

        {/* Rastro âmbar pela rota real, atravessando a ponte. */}
        {trailOn && (
          <g opacity={lit}>
            <path
              d={toD(scene.route)}
              fill="none"
              stroke={palette.sol}
              strokeOpacity={0.2}
              strokeWidth={13}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={`${scene.routeLength} ${scene.routeLength}`}
              strokeDashoffset={scene.routeLength * (1 - trailP)}
            />
            <path
              d={toD(scene.route)}
              fill="none"
              stroke={palette.sol}
              strokeOpacity={0.9}
              strokeWidth={4}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={`${scene.routeLength} ${scene.routeLength}`}
              strokeDashoffset={scene.routeLength * (1 - trailP)}
            />
            <circle cx={head.x} cy={head.y} r={17} fill={palette.sol} fillOpacity={0.28} />
            <circle cx={head.x} cy={head.y} r={6.5} fill={palette.sol} />
          </g>
        )}
      </g>

      {/* O pé do quadro some no fundo da página: o formulário nunca briga com a malha. */}
      <rect x={0} y={L.height * 0.62} width={L.width} height={L.height * 0.38} fill="url(#pe)" />
    </svg>
  )
}
