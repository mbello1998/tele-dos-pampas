// PRÉVIA, SÓ EM DESENVOLVIMENTO. Existe por um motivo: /motoboy exige sessão de `courier`, e o OTP por e-mail
// ainda não entrega código, então o dono não conseguiria olhar a tela que pediu. Esta rota monta o MESMO
// componente de verdade (CallFeed) com chamados de exemplo, sem banco e sem sessão.
//
// Não é um furo na segurança: `notFound()` em produção, e nada aqui lê nem escreve no banco. O que ela NÃO faz:
// o botão ACEITAR chama o server action de verdade, que vai recusar sem sessão — aqui é desenho, não operação.
// Apagar quando o login funcionar.
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { CallFeed } from '@/components/courier/CallFeed'
import type { Call } from '@/components/courier/types'

export const metadata: Metadata = { title: 'Prévia: chamados', robots: { index: false, follow: false } }

const MIN = 60_000

/** Ruas e bairros de verdade das duas cidades: é assim que o motoboy lê a tela. */
function sampleCalls(now: number): Call[] {
  return [
    {
      id: 'previa-1',
      code: 'EXEM01',
      kind: 'delivery',
      status: 'pronto',
      createdAtMs: now - 1 * MIN,
      requesterName: 'Tropical Lanches',
      crossesBorder: false,
      crossesTo: null,
      fee: 8,
      pickup: { street: 'Rua Sete de Setembro', number: '1420', reference: 'em frente à praça', lat: -30.3875, lng: -56.4512 },
      dropoff: { street: 'Rua Pedro Nolasco', number: '77', reference: 'Bairro Gaudêncio Conceição, casa do portão verde', lat: -30.3942, lng: -56.4438 },
      acceptTo: 'aceito',
      steps: [],
      collect: null,
    },
    {
      id: 'previa-2',
      code: 'EXEM02',
      kind: 'courier',
      status: 'pronto',
      createdAtMs: now - 4 * MIN,
      requesterName: null,
      crossesBorder: false,
      crossesTo: null,
      fee: 9,
      pickup: { street: 'Rua dos Andradas', number: '305', reference: 'ao lado da farmácia', lat: -30.3861, lng: -56.4529 },
      dropoff: { street: 'Rua Vinte de Setembro', number: '1130', reference: 'Bairro Promorar, sobrado azul', lat: -30.3989, lng: -56.4601 },
      acceptTo: 'aceito',
      steps: [],
      collect: null,
    },
    {
      id: 'previa-3',
      code: 'EXEM03',
      kind: 'ride',
      status: 'pronto',
      createdAtMs: now - 9 * MIN,
      requesterName: null,
      crossesBorder: true,
      crossesTo: 'Artigas',
      fee: 22,
      pickup: { street: 'Avenida Brasil', number: '540', reference: 'rodoviária', lat: -30.3903, lng: -56.4487 },
      dropoff: { street: 'Calle Lecueder', number: '612', reference: 'frente al hospital', lat: -30.4005, lng: -56.4702 },
      acceptTo: 'aceito',
      steps: [],
      collect: null,
    },
    {
      id: 'previa-4',
      code: 'EXEM04',
      kind: 'delivery',
      status: 'aceito',
      createdAtMs: now - 14 * MIN,
      requesterName: 'João',
      crossesBorder: false,
      crossesTo: null,
      fee: 8,
      pickup: { street: 'Rua General Câmara', number: '88', reference: 'esquina com a Bento Gonçalves', lat: -30.3888, lng: -56.4551 },
      dropoff: { street: 'Rua Duque de Caxias', number: '1502', reference: 'Bairro Cerro do Ouro, perto da escola', lat: -30.3821, lng: -56.4395 },
      acceptTo: null,
      steps: ['coletado', 'em_rota'],
      collect: { amount: 54.5, currency: 'BRL', changeFor: 100 },
    },
  ]
}

export default function PreviaMotoboy() {
  if (process.env.NODE_ENV === 'production') notFound()
  const now = Date.now()
  const calls = sampleCalls(now)
  const queue = calls.filter((c) => c.acceptTo !== null)
  const mine = calls.filter((c) => c.acceptTo === null)

  return (
    <main className="mx-auto min-h-dvh w-full max-w-md px-3 pb-16 pt-4">
      <p className="mb-3 rounded-lg border border-sol/40 bg-sol/10 px-3 py-2 text-sm text-white/80">
        <strong className="font-semibold">Prévia.</strong> Chamados de exemplo, sem banco e sem login, só para
        avaliar o desenho. O botão ACEITAR não vai funcionar aqui.
      </p>
      <CallFeed queue={queue} mine={mine} radiusKm={6} serverNow={now} locale="pt-BR" loadFailed={false} />
    </main>
  )
}
