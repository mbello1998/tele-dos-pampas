// Gera o poster estático do hero (public/hero/poster-malha.svg) a partir da malha simplificada.
//
// Lê o mesmo arquivo que o StreetGridDraw baixa (public/data/grid-simplified.json), então o
// poster e o desenho animado coincidem pixel a pixel. As cores saem de src/styles/tokens.css:
// os hex não são redeclarados aqui.
//
// Rodar depois de scripts/landing/build-grid.ts:  npx tsx scripts/landing/build-poster.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { GRID_VIEWBOX, type Mesh } from '../../src/lib/motion/grid-geometry'

const root = process.cwd()
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

function token(css: string, name: string): string {
  const match = css.match(new RegExp(`--color-${name}:\\s*(#[0-9A-Fa-f]{6})`))
  if (!match) throw new Error(`token --color-${name} não encontrado em tokens.css`)
  return match[1]
}

const css = read('src/styles/tokens.css')
const sol = token(css, 'sol')
const rio = token(css, 'rio')

// A malha simplificada (scripts/landing/build-grid.ts) é a fonte única do desenho e do poster.
const mesh = JSON.parse(read('public/data/grid-simplified.json')) as Mesh
if (!mesh.bridge) throw new Error('grid-simplified.json sem ponte: sem ponte não há poster')

const { quarai, artigas } = mesh.bridge
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID_VIEWBOX} ${GRID_VIEWBOX}" fill="none" stroke-linecap="round" stroke-linejoin="round">`,
  `<path d="${mesh.river}" stroke="${rio}" stroke-opacity=".22" stroke-width="34"/>`,
  `<path d="${mesh.paths.quarai}" stroke="${sol}" stroke-width="2.4"/>`,
  `<path d="${mesh.paths.artigas}" stroke="${rio}" stroke-width="2.4"/>`,
  `<path d="M${quarai.x} ${quarai.y}L${artigas.x} ${artigas.y}" stroke="#fff" stroke-width="6"/>`,
  `<circle cx="${quarai.x}" cy="${quarai.y}" r="11" fill="${sol}" stroke="none"/>`,
  `</svg>`,
].join('\n')

const out = resolve(root, 'public/hero/poster-malha.svg')
mkdirSync(resolve(root, 'public/hero'), { recursive: true })
writeFileSync(out, svg)
console.log(`poster: ${out} (${(svg.length / 1000).toFixed(1)} kB, ${mesh.vertexCount} vértices)`)
