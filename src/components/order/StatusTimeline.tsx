// Linha do tempo do pedido. É construída a partir de order_events, e só deles: a tabela é a trilha de
// auditoria E o que o cliente vê, então a tela não inventa passos que não aconteceram nem esconde os que
// aconteceram. Server-compatível (sem hooks): a hora é formatada no fuso das duas cidades (UTC-3, sem horário
// de verão), com o fuso explícito para o servidor e o navegador gerarem o mesmo texto.
export type TimelineEvent = { id: number; from_status: string | null; to_status: string; created_at: string }

type Props = {
  events: TimelineEvent[]
  /** Texto de cada status, já traduzido. Status sem texto aparece pelo próprio nome (nunca some). */
  labels: Record<string, string>
  locale: 'pt-BR' | 'es-UY'
  /** Mostrado enquanto ainda não há evento algum. */
  emptyLabel?: string
}

const TIME_ZONE = 'America/Sao_Paulo' // Quaraí e Artigas: UTC-3 o ano todo

/** Ordem cronológica; no mesmo instante, a ordem de gravação (id). */
export function sortEvents(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => {
    const d = Date.parse(a.created_at) - Date.parse(b.created_at)
    return d !== 0 && !Number.isNaN(d) ? d : a.id - b.id
  })
}

function formatTime(iso: string, locale: Props['locale']): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TIME_ZONE }).format(d)
}

export function StatusTimeline({ events, labels, locale, emptyLabel }: Props) {
  const ordered = sortEvents(events)
  if (ordered.length === 0) {
    return emptyLabel ? (
      <p className="text-sm text-white/60" data-timeline-empty>
        {emptyLabel}
      </p>
    ) : null
  }
  const lastIndex = ordered.length - 1
  return (
    <ol className="relative space-y-5 border-l border-white/15 pl-6" data-timeline>
      {ordered.map((event, i) => {
        const current = i === lastIndex
        return (
          <li key={event.id} data-status={event.to_status} aria-current={current ? 'step' : undefined} className="relative">
            <span
              aria-hidden="true"
              className={`absolute -left-[31px] top-1 block h-3 w-3 rounded-full ring-4 ring-noite ${current ? 'bg-sol' : 'bg-white/40'}`}
            />
            <p className={`text-base leading-snug ${current ? 'font-semibold text-white' : 'text-white/70'}`}>
              {labels[event.to_status] ?? event.to_status}
            </p>
            <time dateTime={event.created_at} className="preco text-sm text-white/50">
              {formatTime(event.created_at, locale)}
            </time>
          </li>
        )
      })}
    </ol>
  )
}
