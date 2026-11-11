import React from 'react'
import { Composition } from 'remotion'
import mesh from '../public/data/grid-simplified.json'
import { PampaLoop, type LoopProps } from './PampaLoop'
import { FPS, LAYOUTS, LOOP_FRAMES, type Mesh, type Palette } from './scene'

// Valores só para o Remotion Studio. A renderização de verdade recebe a malha e a paleta de
// `scripts/video/render.ts`, que leem public/data/grid-simplified.json e src/styles/tokens.css.
const palette: Palette = { noite: '#0B0F0D', sol: '#F2A516', brasa: '#D9452B', rio: '#2E7D8C', campo: '#1F4D3A' }

export const Root: React.FC = () => (
  <>
    <Composition
      id="pampa-retrato"
      component={PampaLoop}
      durationInFrames={LOOP_FRAMES}
      fps={FPS}
      width={LAYOUTS.retrato.width}
      height={LAYOUTS.retrato.height}
      defaultProps={{ mesh: mesh as unknown as Mesh, palette, format: 'retrato' } satisfies LoopProps}
    />
    <Composition
      id="pampa-paisagem"
      component={PampaLoop}
      durationInFrames={LOOP_FRAMES}
      fps={FPS}
      width={LAYOUTS.paisagem.width}
      height={LAYOUTS.paisagem.height}
      defaultProps={{ mesh: mesh as unknown as Mesh, palette, format: 'paisagem' } satisfies LoopProps}
    />
  </>
)
