'use server'

// A entrega pedida pela loja: cotar e chamar o motoboy. Regras que não se negociam aqui:
//   - quem chama é um `merchant` ATIVO e a loja é DELE: a sessão decide o papel, e a linha de `merchants` é lida
//     com a sessão do próprio dono (RLS devolve só as lojas dele), então o id de loja de outra pessoa é "não
//     encontrado". O banco confere de novo (create_order: TD010 se o perfil não for dono da loja);
//   - a COLETA é a coordenada guardada da loja, lida do banco. A tela nunca manda endereço de coleta;
//   - o endereço do comprador vem da linha de `addresses` do próprio dono (id, nunca coordenada do corpo);
//   - o PREÇO é da plataforma: public.quote_order. A TARIFA É DE QUEM PAGA: convênio (R$ 8) quando a loja paga,
//     balcão (R$ 9) quando quem paga é o comprador. O dono não digita nem altera. O total que
//     a tela viu volta só para ser comparado (diferença acima de R$ 0,01 recusa e vai para audit_log);
//   - a distância é calculada AQUI (routeDistance) e create_order só roda com a chave secreta, DEPOIS da sessão.
//
// Recusas voltam como RESULTADO ({ ok: false, reason, message }), já no idioma do usuário: Server Action que
// lança tem a mensagem trocada por uma genérica em produção.
import 'server-only'
import { createClient as createServiceClient, type SupabaseClient } from '@supabase/supabase-js'
import { getSession } from '@/lib/auth/session'
import { routeDistance } from '@/lib/geo/osrm'
import type { Locale } from '@/lib/i18n'
import { createClient } from '@/lib/supabase/server'
import { parseShopCreateInput, parseShopQuoteInput } from '@/lib/pricing/shop'
import {
  addressToJson,
  failure,
  failureFromDatabase,
  toCustomerQuote,
  type AddressRow,
  type CreateOrderResult,
  type Failure,
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
  ownerId: string
  locale: Locale
  dropoff: Record<string, unknown>
  distanceM: number
  routeSource: 'osrm' | 'haversine'
}

const isFailure = (x: Trip | Failure): x is Failure => 'ok' in x

/** Quem é o dono, de qual loja, para onde vai a sacola e quanto mede o caminho. Tudo do servidor. */
async function resolveTrip(input: { merchantId: string; dropoffAddressId: string }): Promise<Trip | Failure> {
  const session = await getSession()
  const locale: Locale = session?.profile.locale ?? 'pt-BR'
  if (!session) return failure('unauthenticated', locale)
  if (session.profile.status !== 'active' || session.profile.role !== 'merchant') return failure('forbidden', locale)

  const supabase = await createClient()
  const [shop, addr] = await Promise.all([
    supabase.from('merchants').select('id,status,lat,lng').eq('id', input.merchantId).eq('owner_id', session.user.id).maybeSingle(),
    supabase.from('addresses').select(ADDRESS_COLUMNS).eq('id', input.dropoffAddressId).maybeSingle(),
  ])
  if (shop.error) throw new Error(`entrega: leitura de merchants falhou (${shop.error.code ?? 'sem código'})`)
  if (addr.error) throw new Error(`entrega: leitura de addresses falhou (${addr.error.code ?? 'sem código'})`)
  const m = shop.data
  if (!m) return failure('forbidden', locale) // inexistente e de outro dono parecem iguais, de propósito
  if (m.status !== 'approved' || m.lat === null || m.lng === null) return failure('merchant_unavailable', locale)
  const dropoff = addr.data ? addressToJson(addr.data as unknown as AddressRow) : null
  if (!dropoff) return failure('address_not_found', locale)

  const route = await routeDistance({ lat: Number(m.lat), lng: Number(m.lng) }, { lat: dropoff.lat as number, lng: dropoff.lng as number })
  return { ownerId: session.user.id, locale, dropoff, distanceM: route.meters, routeSource: route.source }
}

async function unservedZoneMessage(): Promise<Partial<Record<Locale, string>> | null> {
  const { data } = await serviceClient().from('settings').select('value').eq('key', 'unserved_zone_message').maybeSingle()
  const v = data?.value
  return v && typeof v === 'object' ? (v as Partial<Record<Locale, string>>) : null
}

/** O preço da entrega até este endereço, na tarifa de quem paga. É a mesma conta que create_order refaz depois. */
export async function quoteShopDelivery(raw: unknown): Promise<QuoteResult> {
  const input = parseShopQuoteInput(raw)
  if (!input) return failure('invalid_input', (await getSession())?.profile.locale ?? 'pt-BR')
  const trip = await resolveTrip(input)
  if (isFailure(trip)) return trip

  const { data, error } = await serviceClient().rpc('quote_order', {
    p_kind: 'delivery',
    p_pickup: null, // a coleta é a loja: o banco a lê de `merchants`
    p_dropoff: trip.dropoff,
    p_merchant: input.merchantId,
    p_items: null,
    p_at: new Date().toISOString(),
    p_distance_m: trip.distanceM,
    p_route_source: trip.routeSource,
    p_fee_payer: input.feePayer,
  })
  if (error) {
    console.error('quote_order (loja) falhou', error.code)
    return failureFromDatabase(error, trip.locale, null)
  }
  return { ok: true, quote: toCustomerQuote(data) }
}

/** Chama o motoboy. Devolve o código curto do pedido ou a recusa, no idioma do usuário. */
export async function createShopDelivery(raw: unknown): Promise<CreateOrderResult> {
  const input = parseShopCreateInput(raw)
  if (!input) return failure('invalid_input', (await getSession())?.profile.locale ?? 'pt-BR')
  const trip = await resolveTrip(input)
  if (isFailure(trip)) return trip

  const { data, error } = await serviceClient().rpc('create_order', {
    p_client_id: trip.ownerId, // da sessão verificada, nunca do corpo
    p_kind: 'delivery',
    p_pickup: null,
    p_dropoff: trip.dropoff,
    p_merchant: input.merchantId,
    p_items: null,
    p_payment_method: input.payCurrency === 'UYU' ? 'dinheiro_uyu' : 'dinheiro_brl',
    p_change_for: input.changeFor,
    p_client_total_brl: input.clientTotalBrl,
    p_client_total_uyu: null, // os pesos que a tela mostra são os da mercadoria, não os da entrega
    p_distance_m: trip.distanceM,
    p_route_source: trip.routeSource,
    p_client_notes: null,
    p_load_description: input.loadDescription,
    p_collect_amount_brl: input.collectAmountBrl,
    p_delivery_fee_payer: input.feePayer,
  })

  if (error) {
    // Toque duplo: o banco recusou um segundo pedido idêntico e devolve o código do primeiro em `details`.
    if (error.code === 'TD011' && typeof error.details === 'string' && /^[A-Z0-9]{6}$/.test(error.details)) {
      return {
        ok: true,
        duplicate: true,
        code: error.details,
        totalBrl: input.clientTotalBrl,
        currencyCharged: input.payCurrency,
        totalCharged: 0,
      }
    }
    const reason = failureFromDatabase(error, trip.locale, error.code === 'TD006' ? await unservedZoneMessage() : null)
    if (reason.reason === 'unknown') console.error('create_order (loja) falhou', error.code)
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
    const totalUyu = typeof out.totalUyu === 'number' ? out.totalUyu : null
    return { ...failure('price_changed', trip.locale), currentQuote: { totalBrl: Number(out.totalBrl), totalUyu } }
  }
  console.error('create_order (loja) devolveu um formato inesperado')
  return failure('unknown', trip.locale)
}
