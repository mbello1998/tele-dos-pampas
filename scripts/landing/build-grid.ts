// Gera public/data/grid-simplified.json: a malha das duas cidades só para o DESENHO da landing.
//
// Lê os datasets completos (public/data/quarai.json e artigas.json, que a busca de endereço usa
// com toda a precisão) e NÃO os altera. A geometria visual sai de src/lib/motion/grid-geometry.ts:
// projetada, recortada no quadro da ponte, simplificada (Douglas-Peucker) e arredondada. O
// resultado é uma fração do tamanho do dataset original, porque o leitor está em celular com
// dados contados e a diferença não aparece na escala da animação.
//
// Rodar depois de regenerar os datasets (e então o poster):
//   npx tsx scripts/landing/build-grid.ts && npx tsx scripts/landing/build-poster.ts
// Um teste (tests/unit/motion.test.tsx) falha se o arquivo commitado ficar defasado.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildMesh } from '../../src/lib/motion/grid-geometry'
import type { StreetDataset } from '../../src/lib/geo/types'

const root = process.cwd()
const datasets = (['quarai', 'artigas'] as const).map(
  (city) => JSON.parse(readFileSync(resolve(root, `public/data/${city}.json`), 'utf8')) as StreetDataset,
)
const mesh = buildMesh(datasets)
const out = resolve(root, 'public/data/grid-simplified.json')
const json = JSON.stringify(mesh)
writeFileSync(out, json)
console.log(`grid: ${out} (${(json.length / 1000).toFixed(1)} kB, ${mesh.vertexCount} vértices)`)
