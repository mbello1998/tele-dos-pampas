// Loja aberta = status approved E is_open_manual E hora atual dentro de uma faixa de merchant_hours.
// A chave manual manda: é o que o dono aperta quando o gás acaba, e vale mesmo dentro do horário.
//
// O relógio é o da CIDADE da loja, não o do servidor (UTC). A ponte não tem horário e nunca entra aqui; o único
// limite de tempo além da loja é o horário de serviço do município (06:00 a 00:00), que o quote_order aplica.

export type MerchantHoursRow = { weekday: number; opens_at: string; closes_at: string }

export type MerchantOpenInput = {
  /** Ausente nas linhas de merchants_public (a view só devolve lojas aprovadas). Presente e diferente de approved: fechada. */
  status?: string
  is_open_manual: boolean
  city: string
}

// Slugs de city (0007) e o fuso civil de cada uma. Cidade fora daqui: fechada.
const CITY_TIME_ZONE: Record<string, string> = {
  quarai: 'America/Sao_Paulo',
  artigas: 'America/Montevideo',
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Dia da semana (0 = domingo, como EXTRACT(dow)) e segundos desde a meia-noite, no relógio da cidade. */
function localClock(city: string, now: Date): { weekday: number; seconds: number } | null {
  const timeZone = CITY_TIME_ZONE[city]
  if (!timeZone) return null
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const weekday = WEEKDAY[get('weekday')]
  if (weekday === undefined) return null
  return { weekday, seconds: Number(get('hour')) * 3600 + Number(get('minute')) * 60 + Number(get('second')) }
}

// "HH:MM" ou "HH:MM:SS" (o time do Postgres). Malformado: null, e a faixa não abre a loja.
function toSeconds(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time)
  if (!m) return null
  const [h, min, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)]
  if (h > 24 || min > 59 || s > 59) return null
  return h * 3600 + min * 60 + s
}

export function isMerchantOpen(merchant: MerchantOpenInput, hours: readonly MerchantHoursRow[], now: Date): boolean {
  if (merchant.status !== undefined && merchant.status !== 'approved') return false
  if (!merchant.is_open_manual) return false
  const clock = localClock(merchant.city, now)
  if (!clock) return false

  const yesterday = (clock.weekday + 6) % 7
  for (const row of hours) {
    const opens = toSeconds(row.opens_at)
    const closes = toSeconds(row.closes_at)
    if (opens === null || closes === null) continue

    if (opens === closes) {
      // 24 horas, a mesma convenção do service_hours.
      if (row.weekday === clock.weekday) return true
      continue
    }
    if (opens < closes) {
      if (row.weekday === clock.weekday && clock.seconds >= opens && clock.seconds < closes) return true
      continue
    }
    // Atravessa a meia-noite: a faixa pertence ao dia em que abre; a parte depois das 00:00 conta no dia seguinte.
    if (row.weekday === clock.weekday && clock.seconds >= opens) return true
    if (row.weekday === yesterday && clock.seconds < closes) return true
  }
  return false
}
