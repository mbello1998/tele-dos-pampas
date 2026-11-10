'use server'

// Grava um endereço do cliente logado. A tela já valida, mas isto roda no servidor e NÃO confia nela:
// o que decide se um endereço é salvável é o que está aqui. Regras que importam para quem entrega:
//   - lat/lng sempre presentes e dentro da região das duas cidades (o motor de preço não cota sem eles);
//   - precision só 'gps' | 'quadra' | 'rua', e sem GPS a referência em texto é obrigatória;
//   - rua fora do dataset (streetId null): só com pino/GPS (precision 'gps') E com referência, porque
//     sem rua conhecida são as únicas coisas que o entregador terá;
//   - cidade e país coerentes entre si (a moeda e a taxa de travessia decorrem do país);
//   - o dono da linha é sempre o usuário da sessão, nunca algo que veio no corpo do pedido.
import { createClient } from '@/lib/supabase/server'

export type AddressPrecision = 'gps' | 'quadra' | 'rua'

export type AddressInput = {
  /** Apelido ("casa", "mãe"). Vazio vira "<rua>, <número>". */
  label: string
  /**
   * Id da rua no dataset OSM, ou `null` quando o cliente mora numa rua que o OSM não tem ("não encontrei
   * minha rua"). `street_id is null` é a marca que o dono usa para achar esses endereços e pedir a rua
   * no OpenStreetMap; nesse caso `streetName` é o texto livre digitado.
   */
  streetId: string | null
  streetName: string
  /** Vazio quando a casa não tem número na parede. */
  number: string
  complement: string
  /** Texto derivado do seletor de quadra ("Entre Rua A e Rua B"); vazio se o cliente não soube. */
  betweenStreets: string
  /** Texto livre, campo de primeira classe: o entregador lê isto antes do número. */
  reference: string
  city: 'quarai' | 'artigas'
  country: 'BR' | 'UY'
  lat: number
  lng: number
  precision: AddressPrecision
}

export type Address = AddressInput & { id: string; isDefault: boolean }

const COUNTRY_OF_CITY = { quarai: 'BR', artigas: 'UY' } as const
const PRECISIONS: readonly string[] = ['gps', 'quadra', 'rua']

/**
 * Caixa em volta das duas cidades (dados do OSM + folga de ~25 km). Não decide atendimento (isso é das
 * `zones`): só barra lixo, como 0,0 vindo de um GPS que falhou ou coordenada trocada de lugar.
 */
const REGION = { south: -31.0, north: -30.0, west: -57.0, east: -56.0 }

const MAX = { label: 80, streetName: 120, streetId: 120, number: 20, complement: 80, between: 240, reference: 200 }

function text(value: unknown, field: string, max: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new Error(`invalid_${field}`)
  const v = value.trim()
  if (v.length > max) throw new Error(`invalid_${field}`)
  return v
}

function coordinate(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`invalid_${field}`)
  }
  return Math.round(value * 1e6) / 1e6 // a coluna é numeric(9,6)
}

/** Valida e normaliza. Lança com um código estável (`invalid_<campo>`), nunca com o conteúdo recebido. */
function validate(input: AddressInput): AddressInput {
  if (typeof input !== 'object' || input === null) throw new Error('invalid_input')
  const city = input.city
  if (city !== 'quarai' && city !== 'artigas') throw new Error('invalid_city')
  if (input.country !== COUNTRY_OF_CITY[city]) throw new Error('invalid_country')
  if (!PRECISIONS.includes(input.precision)) throw new Error('invalid_precision')

  const unlisted = input.streetId === null
  const streetId = unlisted ? null : text(input.streetId, 'streetId', MAX.streetId)
  const streetName = text(input.streetName, 'streetName', MAX.streetName)
  if ((!unlisted && !streetId) || !streetName) throw new Error('invalid_street')
  if (unlisted && input.precision !== 'gps') throw new Error('invalid_precision')

  const reference = text(input.reference, 'reference', MAX.reference)
  if ((input.precision !== 'gps' || unlisted) && reference === '') throw new Error('invalid_reference')

  const number = text(input.number, 'number', MAX.number)
  return {
    label: text(input.label, 'label', MAX.label) || (number ? `${streetName}, ${number}` : streetName),
    streetId,
    streetName,
    number,
    complement: text(input.complement, 'complement', MAX.complement),
    betweenStreets: unlisted ? '' : text(input.betweenStreets, 'betweenStreets', MAX.between),
    reference,
    city,
    country: input.country,
    lat: coordinate(input.lat, REGION.south, REGION.north, 'lat'),
    lng: coordinate(input.lng, REGION.west, REGION.east, 'lng'),
    precision: input.precision,
  }
}

type Row = {
  id: string
  label: string | null
  street_id: string | null
  street_name: string | null
  number: string | null
  complement: string | null
  between_streets: string | null
  reference: string | null
  city: 'quarai' | 'artigas'
  country: 'BR' | 'UY'
  lat: number | string
  lng: number | string
  precision: AddressPrecision
  is_default: boolean
}

const COLUMNS =
  'id,label,street_id,street_name,number,complement,between_streets,reference,city,country,lat,lng,precision,is_default'

const toAddress = (r: Row): Address => ({
  id: r.id,
  label: r.label ?? '',
  streetId: r.street_id,
  streetName: r.street_name ?? '',
  number: r.number ?? '',
  complement: r.complement ?? '',
  betweenStreets: r.between_streets ?? '',
  reference: r.reference ?? '',
  city: r.city,
  country: r.country,
  lat: Number(r.lat),
  lng: Number(r.lng),
  precision: r.precision,
  isDefault: r.is_default,
})

export async function saveAddress(input: AddressInput): Promise<Address> {
  const a = validate(input)
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) throw new Error('not_authenticated')

  const row = {
    profile_id: auth.user.id, // RLS exige profile_id = auth.uid(); vir do corpo seria só mais uma coisa a desconfiar
    label: a.label,
    street_id: a.streetId,
    street_name: a.streetName,
    number: a.number || null,
    complement: a.complement || null,
    between_streets: a.betweenStreets || null,
    reference: a.reference || null,
    city: a.city,
    country: a.country,
    lat: a.lat,
    lng: a.lng,
    precision: a.precision,
  }

  // O primeiro endereço da pessoa vira o padrão (o segundo pedido é um toque). Há no máximo um padrão por
  // perfil (índice único parcial); se dois cadastros simultâneos disputarem, o perdedor entra sem padrão.
  const { count } = await supabase.from('addresses').select('id', { count: 'exact', head: true })
  let { data, error } = await supabase
    .from('addresses')
    .insert({ ...row, is_default: (count ?? 0) === 0 })
    .select(COLUMNS)
    .single()
  if (error?.code === '23505') {
    ;({ data, error } = await supabase.from('addresses').insert({ ...row, is_default: false }).select(COLUMNS).single())
  }
  if (error || !data) throw new Error('save_failed')
  return toAddress(data as Row)
}
