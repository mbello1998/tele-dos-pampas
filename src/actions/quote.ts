'use server'

// A cotação da tela inicial, SEM CONTA. É a única coisa que `/` pede ao servidor antes de alguém decidir
// virar cliente, e ela existe porque ninguém cria conta para saber quanto custa.
//
// Regras que não se negociam:
//   - o navegador manda INTENÇÃO: o tipo de serviço e duas coordenadas (ver parseTripQuoteInput). Preço,
//     distância e taxa de câmbio nunca vêm da tela;
//   - a DISTÂNCIA é calculada aqui (routeDistance: OSRM, haversine x 1,35 de reserva, 3 s de limite);
//   - o VALOR é calculado por public.quote_order. `EXECUTE` dessa função é revogado de `authenticated` e de
//     `anon` justamente porque a distância é argumento de confiança: quem chama é este servidor, com a chave
//     secreta, e nunca o navegador;
//   - do ServerQuote só sai o que a tela pode ver (toTripQuote): comissão, taxa e spread de câmbio ficam aqui.
//
// Por ser anônima, a ação tem um limitador por IP, grosso e em memória: não é segurança (um processo novo começa
// com o contador zerado), é só não deixar a tela aberta servir de bomba de cotação para o OSRM e para o banco.
import 'server-only'
import { headers } from 'next/headers'
import { createClient as createServiceClient, type SupabaseClient } from '@supabase/supabase-js'
import { LOGIN_PATH } from '@/lib/auth/access'
import { getSession } from '@/lib/auth/session'
import { routeDistance } from '@/lib/geo/osrm'
import {
  parseTripQuoteInput,
  toTripQuote,
  tripReasonFromSqlState,
  type TripQuoteResult,
} from '@/lib/pricing/trip'

/** Chave secreta: ignora RLS. Um cliente por chamada, nunca em escopo de módulo, nunca exportado. */
function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SECRET_KEY precisam estar definidas no servidor')
  return createServiceClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

const WINDOW_MS = 60_000
const MAX_PER_WINDOW = 40
const hits = new Map<string, number[]>()

async function tooManyQuotes(): Promise<boolean> {
  const h = await headers()
  const ip = (h.get('x-forwarded-for') ?? '').split(',')[0].trim() || h.get('x-real-ip') || 'desconhecido'
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)
  recent.push(now)
  hits.set(ip, recent)
  if (hits.size > 5_000) hits.clear() // teto de memória: o limitador é descartável, não um registro
  return recent.length > MAX_PER_WINDOW
}

/**
 * O preço das duas pontas que a pessoa escolheu. Devolve a cotação (inclusive a recusada pelo banco, com
 * `blocked` e o motivo, que a tela mostra como está) ou um motivo que a tela sabe explicar.
 */
export async function quoteTrip(raw: unknown): Promise<TripQuoteResult> {
  const input = parseTripQuoteInput(raw)
  if (!input) return { ok: false, reason: 'invalid_input' }
  if (await tooManyQuotes()) return { ok: false, reason: 'rate_limited' }

  const route = await routeDistance(input.pickup, input.dropoff)
  const { data, error } = await serviceClient().rpc('quote_order', {
    p_kind: input.kind,
    p_pickup: input.pickup,
    p_dropoff: input.dropoff,
    p_merchant: null,
    p_items: null,
    p_at: new Date().toISOString(),
    p_distance_m: route.meters,
    p_route_source: route.source,
  })
  if (error) {
    const reason = tripReasonFromSqlState(error.code)
    if (reason === 'unknown') console.error('quote_order (sem conta) falhou', error.code)
    return { ok: false, reason }
  }
  return { ok: true, quote: toTripQuote(data) }
}

/**
 * Para onde vai o botão de confirmar. SEM SESSÃO: para o login, com `next` de volta ao pedido — é a única
 * porta desta tela, e é só no confirmar que ela aparece. COM SESSÃO: para a confirmação do pedido, que é
 * onde endereço salvo, pagamento e troco vivem.
 *
 * Esta função NÃO cria pedido e NÃO mexe no login: ela só decide a rota. O fluxo de entrar é de outra tarefa.
 */
export async function requestNextPath(kind: unknown): Promise<string> {
  const k = kind === 'courier' ? 'courier' : 'ride'
  const target = `/pedido/novo?kind=${k}`
  const session = await getSession()
  return session ? target : `${LOGIN_PATH}?next=${encodeURIComponent(target)}`
}
