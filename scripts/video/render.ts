// Renderiza o fundo em movimento da tela de pedido (Remotion, local: nada de renderização na nuvem).
//
//   npm run video                       # os dois formatos, WebM e MP4  -> public/video/
//   npm run video -- --only retrato     # só um formato (retrato | paisagem)
//   npm run video -- --codec webm       # só um codec (webm | mp4)
//   npm run video -- --still retrato 90 # um quadro em PNG para olhar (vai para tmp/video-still/, fora do git)
//
// A malha vem de public/data/grid-simplified.json e a paleta de src/styles/tokens.css: quando um dos dois mudar,
// é só rodar de novo. A primeira execução baixa o Chrome Headless Shell do próprio Remotion (~100 MB, uma vez).
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { bundle } from '@remotion/bundler'
import { ensureBrowser, renderMedia, renderStill, selectComposition } from '@remotion/renderer'
import type { Palette } from '../../video/scene'

const root = path.resolve(__dirname, '../..')
const outDir = path.join(root, 'public', 'video')

type Format = 'retrato' | 'paisagem'
type Codec = 'webm' | 'mp4'

/**
 * Peso de cada arquivo. `scale` reduz a renderização (a composição continua em 1080x1920 / 1920x1080; o arquivo
 * sai menor) e `crf` é a compressão (maior = menor e mais borrado). Ajustados para ficar abaixo de 1,5 MB no
 * retrato e 2,5 MB na paisagem — é fundo de tela, vê-se por trás de um formulário.
 */
const QUALITY: Record<Format, { scale: number; webmCrf: number; mp4Crf: number }> = {
  retrato: { scale: 1, webmCrf: 34, mp4Crf: 28 },
  paisagem: { scale: 1, webmCrf: 34, mp4Crf: 28 },
}

function readPalette(): Palette {
  const css = readFileSync(path.join(root, 'src/styles/tokens.css'), 'utf8')
  const pick = (name: string) => {
    const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9A-Fa-f]{6})`))
    if (!m) throw new Error(`token --color-${name} não encontrado em src/styles/tokens.css`)
    return m[1]
  }
  return { noite: pick('noite'), sol: pick('sol'), brasa: pick('brasa'), rio: pick('rio'), campo: pick('campo') }
}

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main() {
  const mesh = JSON.parse(readFileSync(path.join(root, 'public/data/grid-simplified.json'), 'utf8'))
  const palette = readPalette()
  const formats = (arg('only') ? [arg('only')] : ['retrato', 'paisagem']) as Format[]
  const codecs = (arg('codec') ? [arg('codec')] : ['webm', 'mp4']) as Codec[]

  await ensureBrowser()
  const serveUrl = await bundle({ entryPoint: path.join(root, 'video/index.ts') })

  const still = arg('still')
  if (still) {
    const frame = Number(process.argv[process.argv.indexOf('--still') + 2] ?? 0)
    const format = still as Format
    const dir = path.join(root, 'tmp', 'video-still')
    mkdirSync(dir, { recursive: true })
    const inputProps = { mesh, palette, format }
    const composition = await selectComposition({ serveUrl, id: `pampa-${format}`, inputProps })
    const output = path.join(dir, `${format}-${String(frame).padStart(3, '0')}.png`)
    await renderStill({ composition, serveUrl, output, frame, inputProps })
    console.log(output)
    return
  }

  mkdirSync(outDir, { recursive: true })
  for (const format of formats) {
    const inputProps = { mesh, palette, format }
    const composition = await selectComposition({ serveUrl, id: `pampa-${format}`, inputProps })
    for (const codec of codecs) {
      const q = QUALITY[format]
      const outputLocation = path.join(outDir, `pampa-${format}.${codec}`)
      const started = Date.now()
      await renderMedia({
        composition,
        serveUrl,
        inputProps,
        outputLocation,
        codec: codec === 'webm' ? 'vp9' : 'h264',
        scale: q.scale,
        crf: codec === 'webm' ? q.webmCrf : q.mp4Crf,
        x264Preset: codec === 'mp4' ? 'veryslow' : undefined,
        pixelFormat: 'yuv420p',
        imageFormat: 'png',
        muted: true,
        concurrency: 2, // a máquina tem 8 GB: renderização modesta, e lenta
        logLevel: 'warn',
      })
      const kb = (statSync(outputLocation).size / 1024).toFixed(0)
      console.log(`${path.relative(root, outputLocation)}  ${kb} kB  (${((Date.now() - started) / 1000).toFixed(0)} s)`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
