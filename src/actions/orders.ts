'use server'

// Criação de pedido: a fronteira onde preço vira compromisso. Regras que não se negociam aqui:
//   - o navegador manda INTENÇÃO e o total que viu. Preço de item vem do banco, a distância é calculada AQUI
//     (OSRM, com haversine x 1,35 de reserva), a coordenada vem da linha de `addresses` do próprio cliente e o
//     papel vem da sessão;
//   - o preço é recotado no banco (create_order -> quote_order) e comparado com o que o cliente viu: mais de
//     R$ 0,01 de diferença recusa e fica em audit_log;
//   - nada do ServerQuote chega ao navegador (comissão, taxa e spread de câmbio): ver toCustomerQuote;
//   - create_order só é executável pelo service_role (recebe a distância e o id do cliente como argumentos de
//     confiança). Por isso as chamadas abaixo usam a chave secreta, SÓ depois de a sessão ser verificada, e o id
//     do cliente passado ao banco é sempre o da sessão.
//
// Server Actions que lançam têm a mensagem trocada por uma genérica em produção; por isso as recusas voltam como
// RESULTADO ({ ok: false, reason, message }), já no idioma do usuário, e só o inesperado lança.
import 'server-only'
import { createClient as createServiceClient, type SupabaseClient } from '@supabase/supabase-js'
import { getSession } from '@/lib/auth/session'
import { routeDistance } from '@/lib/geo/osrm'
import type { Locale } from '@/lib/i18n'
import { createClient } from '@/lib/supabase/server'
import {
  addressToJson,
  failure,
  failureFromDatabase,
  parseCreateInput,
  parseQuoteInput,
  toCustomerQuote,
  type AddressRow,
  type CreateOrderResult,
  type Failure,
  type QuoteInput,
  type QuoteResult,
} from '@/app/(cliente)/pedido/novo/order-core'

const ADDRESS_COLUMNS = 'id,label,street_name,number,complement,between_streets,reference,city,country,lat,lng,precision'

/** Chave secreta: ignora RLS. Um cliente por chamada, nunca em escopo de módulo, nunca exportado. */
function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SECRET_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SECRET_KEY precisam estar definidas no servidor')
  return createServiceClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

type Trip = {
  clientId: string
  locale: Locale
  pickup: Record<string, unknown> | null // courier e ride; em food é a loja, lida pelo banco
  dropoff: Record<string, unknown>
  distanceM: number
  routeSource: 'osrm' | 'haversine'
}

/** Quem é o cliente, onde fica cada ponta e quanto mede o caminho. Tudo do servidor. */
async function resolveTrip(input: QuoteInput): Promise<Trip | Failure> {
  const session = await getSession()
  const locale: Locale = session?.profile.locale ?? 'pt-BR'
  if (!session) return failure('unauthenticated', locale)
  if (session.profile.status !== 'active' || session.profile.role !== 'client') return failure('forbidden', locale)

  // Endereços: lidos com a sessão do cliente, então o RLS só devolve os DELE. Id de outra pessoa = não encontrado.
  const wanted = [...new Set([input.dropoffAddressId, ...(input.pickupAddressId ? [input.pickupAddressId] : [])])]
  const supabase = await createClient()
  const { data, error } = await supabase.from('addresses').select(ADDRESS_COLUMNS).in('id', wanted)
  if (error) throw new Error(`pedido: leitura de addresses falhou (${error.code ?? 'sem código'})`)
  const rows = new Map((data as unknown as AddressRow[]).map((r) => [r.id, r]))
  const dropoff = rows.has(input.dropoffAddressId) ? addressToJson(rows.get(input.dropoffAddressId)!) : null
  const pickup = input.pickupAddressId && rows.has(input.pickupAddressId) ? addressToJson(rows.get(input.pickupAddressId)!) : null
  if (!dropoff || (input.kind !== 'food' && !pickup)) return failure('address_not_found', locale)

  // Origem: a loja (do banco) em food; o endereço de coleta nos outros.
  let origin: { lat: number; lng: number }
  if (input.kind === 'food') {
    const { data: m, error: mErr } = await serviceClient()
      .from('merchants')
      .select('status,lat,lng')
      .eq('id', input.merchantId)
      .maybeSingle()
    if (mErr) throw new Error(`pedido: leitura de merchants falhou (${mErr.code ?? 'sem código'})`)
    if (!m || m.status !== 'approved' || m.lat === null || m.lng === null) return failure('merchant_unavailable', locale)
    origin = { lat: Number(m.lat), lng: Number(m.lng) }
  } else {
    origin = { lat: pickup!.lat as number, lng: pickup!.lng as number }
  }

  const route = await routeDistance(origin, { lat: dropoff.lat as number, lng: dropoff.lng as number })
  return {
    clientId: session.user.id,
    locale,
    pickup: input.kind === 'food' ? null : pickup,
    dropoff,
    distanceM: route.meters,
    routeSource: route.source,
  }
}

const isFailure = (x: Trip | Failure): x is Failure => 'ok' in x

async function unservedZoneMessage(): Promise<Partial<Record<Locale, string>> | null> {
  const { data } = await serviceClient().from('settings').select('value').eq('key', 'unserved_zone_message').maybeSingle()
  const v = data?.value
  return v && typeof v === 'object' ? (v as Partial<Record<Locale, string>>) : null
}

const itemsOf = (input: QuoteInput) =>
  input.kind === 'food' ? input.items.map((i) => ({ itemId: i.itemId, qty: i.qty, optionIds: i.optionIds })) : null

/**
 * A cotação que a tela mostra antes de confirmar. É a mesma conta que create_order refaz depois: o total que o
 * cliente vê aqui é o que ele manda de volta em createOrder.
 */
export async function quoteOrder(raw: unknown): Promise<QuoteResult> {
  const input = parseQuoteInput(raw)
  if (!input) return failure('invalid_input', (await getSession())?.profile.locale ?? 'pt-BR')
  const trip = await resolveTrip(input)
  if (isFailure(trip)) return trip

  const { data, error } = await serviceClient().rpc('quote_order', {
    p_kind: input.kind,
    p_pickup: trip.pickup,
    p_dropoff: trip.dropoff,
    p_merchant: input.merchantId,
    p_items: itemsOf(input),
    p_at: new Date().toISOString(),
    p_distance_m: trip.distanceM,
    p_route_source: trip.routeSource,
  })
  if (error) {
    console.error('quote_order falhou', error.code)
    return failureFromDatabase(error, trip.locale, null)
  }
  return { ok: true, quote: toCustomerQuote(data) }
}

/** Cria o pedido. Devolve o código curto (o que se diz ao telefone) ou a recusa, no idioma do usuário. */
export async function createOrder(raw: unknown): Promise<CreateOrderResult> {
  const input = parseCreateInput(raw)
  if (!input) return failure('invalid_input', (await getSession())?.profile.locale ?? 'pt-BR')
  const trip = await resolveTrip(input)
  if (isFailure(trip)) return trip

  const { data, error } = await serviceClient().rpc('create_order', {
    p_client_id: trip.clientId, // da sessão verificada, nunca do corpo
    p_kind: input.kind,
    p_pickup: trip.pickup,
    p_dropoff: trip.dropoff,
    p_merchant: input.merchantId,
    p_items: itemsOf(input),
    p_payment_method: input.paymentMethod,
    p_change_for: input.changeFor,
    p_client_total_brl: input.clientTotalBrl,
    p_client_total_uyu: input.clientTotalUyu,
    p_distance_m: trip.distanceM,
    p_route_source: trip.routeSource,
    p_client_notes: input.notes,
  })

  if (error) {
    // Toque duplo: o banco recusou um segundo pedido idêntico e devolve o código do primeiro em `details`.
    // Para quem tocou duas vezes isso é "já enviado", não um erro.
    if (error.code === 'TD011' && typeof error.details === 'string' && /^[A-Z0-9]{6}$/.test(error.details)) {
      const pesos = input.paymentMethod === 'dinheiro_uyu' && input.clientTotalUyu !== null
      return {
        ok: true,
        duplicate: true,
        code: error.details,
        totalBrl: input.clientTotalBrl,
        currencyCharged: pesos ? 'UYU' : 'BRL',
        totalCharged: pesos ? input.clientTotalUyu! : input.clientTotalBrl,
      }
    }
    const reason = failureFromDatabase(error, trip.locale, error.code === 'TD006' ? await unservedZoneMessage() : null)
    if (reason.reason === 'unknown') console.error('create_order falhou', error.code)
    return reason
  }

  const out = data as Record<string, unknown> | null
  if (out && out.ok === true && typeof out.code === 'string') {
    return {
      ok: true,
      code: out.code,
      totalBrl: Number(out.totalBrl),
      currencyCharged: out.currencyCharged === 'UYU' ? 'UYU' : 'BRL',
      totalCharged: Number(out.totalCharged),
    }
  }
  if (out && out.ok === false && out.code === 'price_mismatch') {
    // O banco já registrou a tentativa em audit_log. O total atual é público: é o que o cliente deve ver agora.
    const totalUyu = typeof out.totalUyu === 'number' ? out.totalUyu : null
    return { ...failure('price_changed', trip.locale), currentQuote: { totalBrl: Number(out.totalBrl), totalUyu } }
  }
  console.error('create_order devolveu um formato inesperado')
  return failure('unknown', trip.locale)
}
