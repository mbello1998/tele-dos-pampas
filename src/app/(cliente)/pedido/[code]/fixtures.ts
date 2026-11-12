// Dados falsos para o teste de ponta a ponta (tests/e2e/tracking.spec.ts) dos caminhos de degradação da tela.
//
// SÓ existe quando o servidor sobe com TRACKING_E2E_FIXTURES=1 (o spec sobe o próprio servidor com isso) e SÓ
// para códigos que começam com "E2E-". Código real tem 6 letras/dígitos sem hífen (gen_order_code), então os
// dois espaços nunca se encontram. Em produção a variável não existe e este arquivo é inalcançável. Os dados
// são inventados: não há, aqui, linha nenhuma de pedido, pessoa ou posição reais.
import type { TrackingData } from './data'

const BASE: Omit<TrackingData, 'code' | 'status' | 'events' | 'position'> = {
  kind: 'courier',
  pickupText: 'Rua Uruguai, 120 (Quaraí)',
  dropoffText: 'Calle Lecueder, 45 (Artigas)',
  destination: { lat: -30.3902, lng: -56.4651 },
  pickup: { lat: -30.3902, lng: -56.4651 },
  dropoff: { lat: -30.3902, lng: -56.4651 },
  tileUrl: 'https://tiles.e2e.test/{z}/{x}/{y}.png',
  attribution: '© e2e',
  etaMinutes: 12,
  crossesBorder: true,
  cancelReason: null,
}

const ev = (id: number, from: string | null, to: string, at: string) => ({ id, from_status: from, to_status: to, created_at: `2026-11-10T${at}:00Z` })

const POSITION = { lat: -30.3875, lng: -56.4528, heading: 90, accuracy_m: 8, recorded_at: '2026-11-10T15:10:00Z' }

const FIXTURES: Record<string, TrackingData> = {
  // Motoboy aceitou, mas ainda não mandou posição nenhuma. Os eventos chegam fora de ordem de propósito.
  'E2E-SEM-POSICAO': {
    ...BASE,
    code: 'E2E-SEM-POSICAO',
    status: 'aceito',
    position: null,
    events: [ev(3, 'aguardando_motoboy', 'aceito', '15:08'), ev(1, null, 'criado', '15:00'), ev(2, 'criado', 'aguardando_motoboy', '15:01')],
  },
  // Motoboy a caminho, com posição; os tiles são interceptados pelo spec (ou carregam, ou falham).
  'E2E-COM-MAPA': {
    ...BASE,
    code: 'E2E-COM-MAPA',
    status: 'em_rota',
    position: POSITION,
    events: [ev(1, null, 'criado', '15:00'), ev(2, 'criado', 'aguardando_motoboy', '15:01'), ev(3, 'aguardando_motoboy', 'aceito', '15:05'), ev(4, 'aceito', 'coletado', '15:09')],
  },
  // Procurando motoboy: o radar.
  'E2E-BUSCANDO': {
    ...BASE,
    code: 'E2E-BUSCANDO',
    status: 'aguardando_motoboy',
    position: null,
    events: [ev(1, null, 'criado', '15:00'), ev(2, 'criado', 'aguardando_motoboy', '15:01')],
  },
  // Entregue, com uma posição "esquecida" na memória: a tela não pode mostrar o motoboy.
  'E2E-ENTREGUE': {
    ...BASE,
    code: 'E2E-ENTREGUE',
    status: 'entregue',
    position: POSITION,
    events: [ev(1, null, 'criado', '15:00'), ev(2, 'aceito', 'coletado', '15:09'), ev(3, 'coletado', 'entregue', '15:30')],
  },
}

/**
 * Três travas, todas precisam abrir: a variável, o prefixo do código e o HOST da requisição ser a própria
 * máquina. A terceira é a que protege um deploy mal configurado: numa URL pública o Host é o domínio do site,
 * nunca localhost, então a variável esquecida ligada não abre a porta. (NODE_ENV não serve de trava: o e2e
 * roda contra o build de produção, onde NODE_ENV é 'production'.)
 */
export function fixtureFor(code: string, host: string | null): TrackingData | null {
  if (process.env.TRACKING_E2E_FIXTURES !== '1' || !code.startsWith('E2E-')) return null
  if (process.env.NETLIFY === 'true' || !host || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return null
  return FIXTURES[code] ?? null
}
