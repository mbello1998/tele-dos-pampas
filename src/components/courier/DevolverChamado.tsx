'use client'

import { useState } from 'react'
import { devolverChamado } from '@/actions/chat'
import type { Locale } from '@/lib/money/format'

/**
 * "FUREI O PNEU, PASSA PRA OUTRO."
 *
 * Sem este botão o motoboy tem duas saídas e as duas são ruins: sumir (e o cliente espera uma moto que não
 * vem) ou ligar para alguém resolver na mão. O chamado volta para a fila e qualquer colega pega — numa
 * cidade pequena, onde todo mundo está olhando a mesma lista, isso é mais rápido do que escolher alguém.
 *
 * O MOTIVO É OBRIGATÓRIO e vai direto para o chat do cliente. Devolver em silêncio deixaria quem espera sem
 * explicação, que é exatamente o problema que o botão existe para resolver.
 *
 * Confirmação em dois toques, de propósito: isto cancela o trabalho dele e mexe no pedido de outra pessoa.
 * Um toque acidental de luva não pode desfazer uma corrida aceita.
 */

const MOTIVOS: Record<Locale, string[]> = {
  'pt-BR': ['Furei o pneu', 'Problema na moto', 'Me senti mal', 'Estou longe demais', 'Emergência pessoal'],
  'es-UY': ['Pinché una goma', 'Problema en la moto', 'Me sentí mal', 'Estoy demasiado lejos', 'Emergencia personal'],
}

const T: Record<Locale, Record<'abrir' | 'titulo' | 'ajuda' | 'cancelar' | 'confirmar' | 'enviando' | 'aBordo' | 'falhou', string>> = {
  'pt-BR': {
    abrir: 'Não consigo fazer esta corrida',
    titulo: 'Devolver o chamado para a fila',
    ajuda: 'O cliente é avisado na hora, com o motivo. Outro motoboy pode pegar.',
    cancelar: 'Voltar',
    confirmar: 'Devolver o chamado',
    enviando: 'Devolvendo…',
    aBordo: 'A carga já está com você. Combine o repasse pelo chat — não dá para devolver pelo aplicativo depois de coletar.',
    falhou: 'Não deu para devolver. Tente de novo.',
  },
  'es-UY': {
    abrir: 'No puedo hacer este viaje',
    titulo: 'Devolver el pedido a la fila',
    ajuda: 'El cliente se entera al toque, con el motivo. Otro motoboy puede agarrarlo.',
    cancelar: 'Volver',
    confirmar: 'Devolver el pedido',
    enviando: 'Devolviendo…',
    aBordo: 'La carga ya está con vos. Coordiná el pase por el chat — no se puede devolver por la app después de recoger.',
    falhou: 'No se pudo devolver. Intentá de nuevo.',
  },
}

export function DevolverChamado({ orderId, locale }: { orderId: string; locale: Locale }) {
  const [aberto, setAberto] = useState(false)
  const [motivo, setMotivo] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const t = T[locale]

  if (!aberto) {
    return (
      <button
        type="button"
        onClick={() => setAberto(true)}
        className="min-h-11 w-full rounded-lg border border-borda px-3 text-sm font-medium text-white/70"
        data-devolver="fechado"
      >
        {t.abrir}
      </button>
    )
  }

  const devolver = async (texto: string) => {
    if (enviando) return
    setEnviando(true)
    setErro(null)
    const r = await devolverChamado(orderId, texto)
    setEnviando(false)
    if (r.ok) {
      setAberto(false)
      return
    }
    setErro(r.erro === 'a_bordo' ? t.aBordo : t.falhou)
  }

  return (
    <section className="rounded-xl border border-brasa/50 bg-brasa/10 p-3" data-devolver="aberto">
      <h3 className="text-base font-bold text-white">{t.titulo}</h3>
      <p className="mt-0.5 text-sm text-white/70">{t.ajuda}</p>

      {/* Motivos prontos primeiro: de luva, parado no sol, ninguém escreve. O campo livre existe para o
          caso que a lista não prevê. */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {MOTIVOS[locale].map((m) => (
          <button
            key={m}
            type="button"
            disabled={enviando}
            onClick={() => void devolver(m)}
            className="min-h-11 rounded-full border border-borda bg-poco px-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            {m}
          </button>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <input
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          maxLength={300}
          placeholder={locale === 'pt-BR' ? 'Outro motivo…' : 'Otro motivo…'}
          className="min-h-12 flex-1 rounded-lg border border-borda bg-poco px-3 text-base text-white placeholder:text-white/35"
        />
        <button
          type="button"
          disabled={enviando || motivo.trim().length < 3}
          onClick={() => void devolver(motivo)}
          className="min-h-12 rounded-lg bg-brasa px-4 text-base font-bold text-white disabled:opacity-40"
        >
          {enviando ? t.enviando : t.confirmar}
        </button>
      </div>

      {erro ? <p className="mt-2 text-sm font-semibold text-white">{erro}</p> : null}

      <button
        type="button"
        onClick={() => {
          setAberto(false)
          setErro(null)
        }}
        className="mt-2 min-h-11 w-full text-sm text-white/60"
      >
        {t.cancelar}
      </button>
    </section>
  )
}
