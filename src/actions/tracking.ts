'use server'

// A rota para o rastreio. Existe como Server Action por dois motivos:
//   1. a coordenada de quem pediu não vai para o roteador a partir do navegador dela. Quem fala com o OSRM é
//      o nosso servidor; de fora, vê-se o nosso IP, não o da pessoa esperando na calçada;
//   2. é o mesmo `fetchRoute` que o resto do app usa, então a linha desenhada é a mesma que a conta usou.
//
// Só devolve geometria: nenhum preço, nenhum dado de pedido. Exige sessão — rota de graça para qualquer um
// seria um roteador público pago com a nossa conta.
import 'server-only'
import { fetchRoute, type Route } from '@/lib/geo/route'
import type { LatLng } from '@/lib/geo/types'
import { getSession } from '@/lib/auth/session'

const REGIAO = { sul: -31.0, norte: -30.0, oeste: -57.0, leste: -56.0 }

const pontoValido = (p: unknown): p is LatLng => {
  if (typeof p !== 'object' || p === null) return false
  const { lat, lng } = p as { lat?: unknown; lng?: unknown }
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= REGIAO.sul &&
    lat <= REGIAO.norte &&
    lng >= REGIAO.oeste &&
    lng <= REGIAO.leste
  )
}

export async function rotaEntre(de: unknown, para: unknown): Promise<Route | null> {
  if (!pontoValido(de) || !pontoValido(para)) return null
  if (!(await getSession())) return null
  return fetchRoute(de, para)
}
