'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { enviarFoto, enviarLocal, enviarTexto, listarMensagens, urlDaFoto, type ChatMessage } from '@/actions/chat'
import { createClient } from '@/lib/supabase/client'
import type { Locale } from '@/lib/money/format'
import { PRONTOS_CLIENTE, PRONTOS_MOTOBOY, type Pronto } from './prontos'

/**
 * O CHAT DO PEDIDO, igual dos dois lados.
 *
 * QUANDO ELE ABRE SOZINHO, que é a decisão que faz ou quebra esta tela: a 90 segundos da chegada. Não antes.
 * Durante a maior parte da corrida não há o que combinar, e um chat aberto o tempo todo é mais uma caixa
 * disputando a tela de quem está dirigindo. Mas no último minuto e meio tudo o que importa é a porta:
 * "passou por mim", "estou no portão azul", "toca a campainha". É exatamente aí que ele aparece.
 *
 * Numa corrida mais curta que 90 s ele já nasce aberto — não há "antes" para esconder. E dá para abrir na
 * mão a qualquer momento: a regra automática acerta o caso comum, não todos.
 *
 * Mensagem nova com o chat fechado abre o chat. Chegou recado, a pessoa lê.
 */

const ABRE_A_SEGUNDOS = 90

type Props = {
  orderId: string
  locale: Locale
  lado: 'cliente' | 'motoboy'
  /** Segundos até a chegada. `null` enquanto não há estimativa. */
  faltamSegundos: number | null
  /** Pedido encerrado: a conversa fica legível, mas ninguém escreve mais. */
  encerrado?: boolean
}

export function OrderChat({ orderId, locale, lado, faltamSegundos, encerrado = false }: Props) {
  const [aberto, setAberto] = useState(false)
  const [mensagens, setMensagens] = useState<ChatMessage[]>([])
  const [texto, setTexto] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const fim = useRef<HTMLDivElement>(null)
  const abriuSozinho = useRef(false)
  const vistaRef = useRef(0)

  const prontos: Pronto[] = (lado === 'motoboy' ? PRONTOS_MOTOBOY : PRONTOS_CLIENTE)[locale]
  const t = TEXTOS[locale]

  const recarregar = useCallback(async () => {
    setMensagens(await listarMensagens(orderId))
  }, [orderId])

  // A primeira carga e o canal ao vivo.
  useEffect(() => {
    let vivo = true
    void listarMensagens(orderId).then((m) => {
      if (vivo) setMensagens(m)
    })
    const canal = createClient()
      .channel(`chat:${orderId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'order_messages', filter: `order_id=eq.${orderId}` },
        () => {
          // Relê a lista inteira em vez de aproveitar o payload: é uma conversa curta, e assim o que aparece
          // na tela é exatamente o que a RLS deixa ler — sem uma segunda regra de visibilidade no cliente.
          void listarMensagens(orderId).then((m) => {
            if (vivo) setMensagens(m)
          })
        },
      )
      .subscribe()
    return () => {
      vivo = false
      void canal.unsubscribe()
    }
  }, [orderId])

  // Abre sozinho perto da chegada — uma vez só, para não reabrir depois de a pessoa fechar.
  useEffect(() => {
    if (abriuSozinho.current || aberto || encerrado) return
    if (faltamSegundos !== null && faltamSegundos <= ABRE_A_SEGUNDOS) {
      abriuSozinho.current = true
      setAberto(true)
    }
  }, [faltamSegundos, aberto, encerrado])

  // Recado novo com o chat fechado: abre, porque recado parado não serve para nada.
  const ultimaId = mensagens.length > 0 ? mensagens[mensagens.length - 1].id : 0
  useEffect(() => {
    if (ultimaId === 0 || ultimaId === vistaRef.current) return
    if (aberto) {
      vistaRef.current = ultimaId
      fim.current?.scrollIntoView({ block: 'end' })
    } else if (vistaRef.current !== 0) {
      setAberto(true)
    } else {
      vistaRef.current = ultimaId
    }
  }, [ultimaId, aberto])

  const enviar = useCallback(
    async (acao: () => Promise<{ ok: boolean }>) => {
      if (enviando) return
      setEnviando(true)
      setErro(null)
      const r = await acao()
      if (r.ok) await recarregar()
      else setErro(t.falhou)
      setEnviando(false)
    },
    [enviando, recarregar, t.falhou],
  )

  const mandarLocal = () => {
    if (!navigator.geolocation) return setErro(t.semLocal)
    navigator.geolocation.getCurrentPosition(
      (p) => void enviar(() => enviarLocal(orderId, p.coords.latitude, p.coords.longitude)),
      () => setErro(t.semLocal),
      { enableHighAccuracy: true, timeout: 10_000 },
    )
  }

  const mandarFoto = async (arquivo: File) => {
    if (arquivo.size > 5 * 1024 * 1024) return setErro(t.fotoGrande)
    setEnviando(true)
    setErro(null)
    // Sobe direto para o bucket: o arquivo não passa pelo nosso servidor, e a policy do storage é quem
    // autoriza. O caminho começa pelo id do pedido porque é disso que a policy depende.
    const caminho = `${orderId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { error } = await createClient()
      .storage.from('chat-fotos')
      .upload(caminho, arquivo, { contentType: arquivo.type })
    setEnviando(false)
    if (error) return setErro(t.falhou)
    await enviar(() => enviarFoto(orderId, caminho))
  }

  if (encerrado && mensagens.length === 0) return null

  if (!aberto) {
    return (
      <button
        type="button"
        onClick={() => setAberto(true)}
        className="flex min-h-12 w-full items-center justify-between rounded-lg border border-borda bg-superficie px-4 text-base font-semibold text-white"
        data-chat="fechado"
      >
        <span>{lado === 'motoboy' ? t.abrirCliente : t.abrirMotoboy}</span>
        <span aria-hidden="true">&#9654;</span>
      </button>
    )
  }

  return (
    <section className="rounded-xl border border-borda bg-superficie" data-chat="aberto" aria-label={t.titulo}>
      <header className="flex items-center justify-between border-b border-borda px-4 py-2">
        <h2 className="text-base font-bold text-white">{t.titulo}</h2>
        <button type="button" onClick={() => setAberto(false)} className="min-h-11 px-2 text-sm text-white/60">
          {t.fechar}
        </button>
      </header>

      <div className="max-h-64 overflow-y-auto px-3 py-2" role="log" aria-live="polite">
        {mensagens.length === 0 ? (
          <p className="py-4 text-center text-sm text-white/50">{t.vazio}</p>
        ) : (
          mensagens.map((m) => (
            <Balao key={m.id} m={m} meu={m.senderRole === (lado === 'motoboy' ? 'courier' : 'client')} locale={locale} />
          ))
        )}
        <div ref={fim} />
      </div>

      {!encerrado && (
        <div className="border-t border-borda p-3">
          {/* OS PRONTOS VÊM PRIMEIRO, antes do campo de digitar. Na moto, de luva, é por aqui que a mensagem
              sai — o teclado é o caminho de exceção, não o principal. */}
          <div className="mb-2 flex flex-wrap gap-1.5">
            {prontos.map((p) => (
              <button
                key={p.rotulo}
                type="button"
                disabled={enviando}
                onClick={() => void enviar(() => enviarTexto(orderId, p.texto))}
                className={`min-h-11 rounded-full border px-3 text-sm font-semibold disabled:opacity-50 ${
                  p.urgente ? 'border-brasa/60 bg-brasa/15 text-white' : 'border-borda bg-poco text-white/85'
                }`}
              >
                {p.rotulo}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && texto.trim() !== '') {
                  const atual = texto
                  setTexto('')
                  void enviar(() => enviarTexto(orderId, atual))
                }
              }}
              placeholder={t.digite}
              maxLength={1000}
              className="min-h-12 flex-1 rounded-lg border border-borda bg-poco px-3 text-base text-white placeholder:text-white/35"
            />
            <label
              className="flex min-h-12 cursor-pointer items-center rounded-lg border border-borda bg-poco px-3 text-base text-white"
              title={t.foto}
            >
              <span aria-hidden="true">&#128247;</span>
              <span className="sr-only">{t.foto}</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void mandarFoto(f)
                  e.target.value = ''
                }}
              />
            </label>
            <button
              type="button"
              onClick={mandarLocal}
              disabled={enviando}
              title={t.local}
              className="min-h-12 rounded-lg border border-borda bg-poco px-3 text-base text-white disabled:opacity-50"
            >
              <span aria-hidden="true">&#128205;</span>
              <span className="sr-only">{t.local}</span>
            </button>
          </div>
          {erro ? <p className="mt-2 text-sm text-brasa">{erro}</p> : null}
        </div>
      )}
    </section>
  )
}

function Balao({ m, meu, locale }: { m: ChatMessage; meu: boolean; locale: Locale }) {
  const [foto, setFoto] = useState<string | null>(null)
  useEffect(() => {
    if (m.kind !== 'foto' || !m.photoPath) return
    void urlDaFoto(m.photoPath).then(setFoto)
  }, [m.kind, m.photoPath])

  const hora = new Date(m.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  return (
    <div className={`mb-2 flex ${meu ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] rounded-xl px-3 py-2 ${meu ? 'bg-sol/20' : 'bg-poco'} text-white`}>
        {m.kind === 'texto' ? <p className="text-base leading-snug">{m.body}</p> : null}
        {m.kind === 'local' && m.lat != null && m.lng != null ? (
          <a
            href={`https://www.openstreetmap.org/?mlat=${m.lat}&mlon=${m.lng}#map=18/${m.lat}/${m.lng}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-base font-semibold text-sol underline"
          >
            {locale === 'pt-BR' ? 'Ver onde estou' : 'Ver dónde estoy'}
          </a>
        ) : null}
        {m.kind === 'foto' ? (
          foto ? (
            // eslint-disable-next-line @next/next/no-img-element -- URL assinada de curta duração, fora do otimizador
            <img src={foto} alt="" className="max-h-48 rounded-lg" />
          ) : (
            <span className="text-sm text-white/50">…</span>
          )
        ) : null}
        <span className="mt-0.5 block text-right text-xs text-white/45">{hora}</span>
      </div>
    </div>
  )
}

type Chave = 'titulo' | 'abrirMotoboy' | 'abrirCliente' | 'fechar' | 'vazio' | 'digite' | 'foto' | 'local' | 'falhou' | 'semLocal' | 'fotoGrande'

const TEXTOS: Record<Locale, Record<Chave, string>> = {
  'pt-BR': {
    titulo: 'Conversa',
    abrirMotoboy: 'Falar com o motoboy',
    abrirCliente: 'Falar com o cliente',
    fechar: 'Fechar',
    vazio: 'Nenhuma mensagem ainda.',
    digite: 'Escreva…',
    foto: 'Mandar foto',
    local: 'Mandar minha localização',
    falhou: 'Não deu para enviar. Tente de novo.',
    semLocal: 'Sem permissão de localização.',
    fotoGrande: 'A foto passa de 5 MB.',
  },
  'es-UY': {
    titulo: 'Conversación',
    abrirMotoboy: 'Hablar con el motoboy',
    abrirCliente: 'Hablar con el cliente',
    fechar: 'Cerrar',
    vazio: 'Todavía no hay mensajes.',
    digite: 'Escribí…',
    foto: 'Mandar foto',
    local: 'Mandar mi ubicación',
    falhou: 'No se pudo enviar. Intentá de nuevo.',
    semLocal: 'Sin permiso de ubicación.',
    fotoGrande: 'La foto pasa de 5 MB.',
  },
}
