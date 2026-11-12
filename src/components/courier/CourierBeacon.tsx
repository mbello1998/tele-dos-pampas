'use client'

import { useEffect, useRef, useState } from 'react'
import { publishPosition, type PublishResult } from '@/lib/realtime/position'
import { SEM_SINAL_MS } from '@/lib/realtime/estimate'
import type { Locale } from '@/lib/money/format'

/**
 * O FAROL. Lê o GPS do motoboy e manda a posição para o pedido que ele está fazendo.
 *
 * Isto faltava inteiro: o encanamento do tempo real existia dos dois lados — o envio, o canal, o marcador que
 * desliza — e ninguém chamava o envio. Resultado: o cliente abria o rastreio e esperava para sempre uma
 * posição que nunca ia sair.
 *
 * O aviso aqui é PARA O MOTOBOY, e é diferente do que o cliente vê. O cliente precisa saber que a posição na
 * tela dele é estimada. O motoboy precisa saber que **o cliente está sem vê-lo** — é informação de trabalho:
 * é o momento de ele esperar uma ligação, ou de subir a rua para pegar sinal.
 */

type Estado = 'iniciando' | 'enviando' | 'sem_sinal' | 'negado' | 'indisponivel'

const COPY: Record<Locale, Record<Estado, string> & { hint: string }> = {
  'pt-BR': {
    iniciando: 'Ligando o rastreio…',
    enviando: 'O cliente está vendo você chegar',
    sem_sinal: 'Sem sinal: o cliente está vendo uma estimativa, não você',
    negado: 'Sem permissão de localização — o cliente não vê você chegando',
    indisponivel: 'Este aparelho não dá a localização',
    hint: 'Deixe esta tela aberta enquanto faz a corrida.',
  },
  'es-UY': {
    iniciando: 'Encendiendo el rastreo…',
    enviando: 'El cliente te está viendo llegar',
    sem_sinal: 'Sin señal: el cliente ve una estimación, no a vos',
    negado: 'Sin permiso de ubicación — el cliente no te ve llegando',
    indisponivel: 'Este dispositivo no da la ubicación',
    hint: 'Dejá esta pantalla abierta mientras hacés el viaje.',
  },
}

const COR: Record<Estado, string> = {
  iniciando: 'border-borda bg-superficie text-white/70',
  enviando: 'border-campo/60 border-l-4 border-l-campo bg-campo/15 text-white',
  sem_sinal: 'border-rio/60 border-l-4 border-l-rio bg-rio/10 text-white',
  negado: 'border-brasa/60 border-l-4 border-l-brasa bg-brasa/10 text-white',
  indisponivel: 'border-brasa/60 border-l-4 border-l-brasa bg-brasa/10 text-white',
}

export function CourierBeacon({ orderId, locale }: { orderId: string; locale: Locale }) {
  const [estado, setEstado] = useState<Estado>('iniciando')
  const ultimoEnvio = useRef(0)

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setEstado('indisponivel')
      return
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        void publishPosition(orderId, {
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          heading: Number.isFinite(p.coords.heading) ? p.coords.heading : null,
          accuracy_m: p.coords.accuracy,
        }).then((r: PublishResult) => {
          // 'throttled' também conta como vivo: o limitador segurou porque a anterior é recente, não porque
          // falhou. Marcar isso como problema assustaria o motoboy a cada dez segundos.
          if (r === 'sent' || r === 'throttled') {
            ultimoEnvio.current = Date.now()
            setEstado('enviando')
          }
        })
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) setEstado('negado')
        // Os outros erros (timeout, posição indisponível) são passageiros: o relógio abaixo cuida deles, e
        // trocar a mensagem a cada tropeço do GPS deixaria o aviso piscando sem parar.
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    )

    // O relógio que detecta o silêncio. `watchPosition` simplesmente para de chamar quando o sinal some: sem
    // um relógio próprio, a tela ficaria dizendo "o cliente está vendo você" com o aparelho fora do ar.
    const relogio = setInterval(() => {
      setEstado((atual) => {
        if (atual === 'negado' || atual === 'indisponivel') return atual
        if (ultimoEnvio.current === 0) return atual
        return Date.now() - ultimoEnvio.current > SEM_SINAL_MS ? 'sem_sinal' : 'enviando'
      })
    }, 2_000)

    return () => {
      navigator.geolocation.clearWatch(id)
      clearInterval(relogio)
    }
  }, [orderId])

  const c = COPY[locale]
  return (
    <p role="status" className={`rounded-lg border px-3 py-2 text-sm ${COR[estado]}`} data-beacon={estado}>
      <span className="font-semibold">{c[estado]}</span>
      {estado === 'enviando' || estado === 'iniciando' ? <span className="block text-white/60">{c.hint}</span> : null}
    </p>
  )
}
