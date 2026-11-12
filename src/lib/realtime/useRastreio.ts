'use client'

import { useEffect, useRef, useState } from 'react'
import { rotaEntre } from '@/actions/tracking'
import { projectOnto, type Route } from '@/lib/geo/route'
import type { LatLng } from '@/lib/geo/types'
import { estimar, type Estimativa, type Fix } from './estimate'

/**
 * O RASTREIO, do jeito que as duas telas precisam dele.
 *
 * Um gancho só, usado pelo cliente e pelo motoboy, para os dois verem o mesmo número. Ele junta as três
 * peças: a rota pelas ruas (servidor), as leituras que chegam em tempo real (quem chama passa) e o motor de
 * estimativa, que roda a cada segundo mesmo sem leitura nova — é isso que faz o marcador continuar andando
 * quando o sinal cai, e o tempo de chegada diminuir sozinho em vez de ficar parado mentindo.
 */

/** Desviou mais que isto da linha: ele pegou outra rua, e a rota precisa ser refeita. */
const DESVIO_M = 90
/** Teto para não martelar o roteador quando o GPS está ruim e "desvia" a cada leitura. */
const MIN_ENTRE_ROTAS_MS = 45_000

export type Rastreio = {
  rota: Route | null
  estimativa: Estimativa | null
  /** A rota ainda não chegou (primeira busca). A tela mostra o endereço, não um mapa vazio. */
  carregando: boolean
}

export function useRastreio(fixes: readonly Fix[], destino: LatLng | null): Rastreio {
  const [rota, setRota] = useState<Route | null>(null)
  const [carregando, setCarregando] = useState(false)
  const [agora, setAgora] = useState(() => Date.now())
  const ultimaBusca = useRef(0)
  const buscando = useRef(false)

  const ultimo = fixes.length > 0 ? fixes[fixes.length - 1] : null

  // O relógio. Um segundo é o passo certo: a contagem para o próximo sinal é em segundos, e o marcador
  // deduzido anda pouco demais para valer um quadro a cada 16 ms.
  useEffect(() => {
    const id = setInterval(() => setAgora(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // A rota. Buscada quando não há nenhuma, quando o destino muda, e quando o motoboy sai dela.
  useEffect(() => {
    if (!ultimo || !destino || buscando.current) return
    const precisa =
      rota === null ||
      (Date.now() - ultimaBusca.current > MIN_ENTRE_ROTAS_MS &&
        projectOnto(rota, ultimo).offMeters > DESVIO_M)
    if (!precisa) return

    buscando.current = true
    setCarregando(rota === null)
    void rotaEntre({ lat: ultimo.lat, lng: ultimo.lng }, destino)
      .then((r) => {
        if (r) {
          setRota(r)
          ultimaBusca.current = Date.now()
        }
      })
      .catch(() => {
        // Sem rota nova: a anterior continua valendo, e sem nenhuma a tela cai no endereço em texto.
      })
      .finally(() => {
        buscando.current = false
        setCarregando(false)
      })
  }, [ultimo, destino, rota])

  // O destino mudou de verdade (o motoboy pegou o passageiro e agora vai para a entrega): a rota velha não
  // serve mais, e manter a antiga desenharia o caminho errado com toda a confiança.
  const destinoRef = useRef(destino)
  useEffect(() => {
    const a = destinoRef.current
    if (a && destino && (a.lat !== destino.lat || a.lng !== destino.lng)) setRota(null)
    destinoRef.current = destino
  }, [destino])

  return {
    rota,
    estimativa: rota ? estimar(fixes, rota, agora) : null,
    carregando,
  }
}
