'use server'

// O chat do pedido. Tudo passa por aqui, e tudo depende da RLS: estas ações usam a SESSÃO da pessoa, nunca a
// chave secreta. Se a policy recusar, a ação recusa — não há um caminho privilegiado que a contorne.
//
// O papel de quem fala é lido do PERFIL, nunca do corpo do pedido: senão um cliente mandaria mensagem
// assinada como motoboy.
import 'server-only'
import { getSession } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'

export type ChatMessage = {
  id: number
  senderId: string
  senderRole: 'client' | 'courier' | 'merchant' | 'fleet' | 'admin'
  kind: 'texto' | 'foto' | 'local'
  body: string | null
  photoPath: string | null
  lat: number | null
  lng: number | null
  createdAt: string
  readAt: string | null
}

export type ChatResult = { ok: true; message: ChatMessage } | { ok: false; reason: 'sem_sessao' | 'recusado' | 'invalido' }

const COLUNAS = 'id, sender_id, sender_role, kind, body, photo_path, lat, lng, created_at, read_at'

type Row = {
  id: number
  sender_id: string
  sender_role: ChatMessage['senderRole']
  kind: ChatMessage['kind']
  body: string | null
  photo_path: string | null
  lat: number | string | null
  lng: number | string | null
  created_at: string
  read_at: string | null
}

const toMessage = (r: Row): ChatMessage => ({
  id: r.id,
  senderId: r.sender_id,
  senderRole: r.sender_role,
  kind: r.kind,
  body: r.body,
  photoPath: r.photo_path,
  lat: r.lat === null ? null : Number(r.lat),
  lng: r.lng === null ? null : Number(r.lng),
  createdAt: r.created_at,
  readAt: r.read_at,
})

const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

/** As mensagens daquele pedido, em ordem. A RLS decide o que volta; aqui não há filtro de dono. */
export async function listarMensagens(orderId: unknown): Promise<ChatMessage[]> {
  if (!uuid(orderId)) return []
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('order_messages')
    .select(COLUNAS)
    .eq('order_id', orderId)
    .order('created_at', { ascending: true })
    .limit(200)
  if (error) return []
  return (data as unknown as Row[]).map(toMessage)
}

async function inserir(
  orderId: string,
  campos: Partial<Pick<Row, 'kind' | 'body' | 'photo_path' | 'lat' | 'lng'>>,
): Promise<ChatResult> {
  const sessao = await getSession()
  if (!sessao) return { ok: false, reason: 'sem_sessao' }
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('order_messages')
    .insert({ order_id: orderId, sender_id: sessao.user.id, sender_role: sessao.profile.role, ...campos })
    .select(COLUNAS)
    .single()
  // A policy recusa quem não é parte do pedido e quem escreve em pedido fechado. Os dois voltam como
  // 'recusado': a tela não precisa (e não deve) distinguir "não é seu" de "já acabou".
  if (error) return { ok: false, reason: 'recusado' }
  return { ok: true, message: toMessage(data as unknown as Row) }
}

export async function enviarTexto(orderId: unknown, texto: unknown): Promise<ChatResult> {
  if (!uuid(orderId)) return { ok: false, reason: 'invalido' }
  const t = typeof texto === 'string' ? texto.trim() : ''
  if (t.length < 1 || t.length > 1000) return { ok: false, reason: 'invalido' }
  return inserir(orderId, { kind: 'texto', body: t })
}

/** "Estou aqui". Manda a coordenada de quem envia — é o que resolve "passou por mim e não me viu". */
export async function enviarLocal(orderId: unknown, lat: unknown, lng: unknown): Promise<ChatResult> {
  if (!uuid(orderId)) return { ok: false, reason: 'invalido' }
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, reason: 'invalido' }
  }
  // A mesma caixa das duas cidades que o banco também confere: coordenada de GPS que falhou não vira mensagem.
  if (lat < -31 || lat > -30 || lng < -57 || lng > -56) return { ok: false, reason: 'invalido' }
  return inserir(orderId, { kind: 'local', lat, lng })
}

/** A foto já subiu para o bucket pelo navegador (a policy do storage decidiu); aqui só entra a referência. */
export async function enviarFoto(orderId: unknown, caminho: unknown): Promise<ChatResult> {
  if (!uuid(orderId)) return { ok: false, reason: 'invalido' }
  const c = typeof caminho === 'string' ? caminho.trim() : ''
  // O caminho TEM de começar pela pasta do pedido: é essa convenção que a policy do bucket usa para
  // autorizar. Aceitar outro formato aqui abriria a porta que a policy fecha.
  if (!c.startsWith(`${orderId}/`) || c.length > 400 || c.includes('..')) return { ok: false, reason: 'invalido' }
  return inserir(orderId, { kind: 'foto', photo_path: c })
}

/** URL de curta duração para ver a foto. O bucket é privado: sem isto a imagem não abre. */
export async function urlDaFoto(caminho: unknown): Promise<string | null> {
  if (typeof caminho !== 'string' || caminho.includes('..')) return null
  if (!(await getSession())) return null
  const supabase = await createClient()
  const { data } = await supabase.storage.from('chat-fotos').createSignedUrl(caminho, 600)
  return data?.signedUrl ?? null
}

/** Devolver o chamado à fila, com motivo. O banco recusa se a carga já estiver a bordo. */
export async function devolverChamado(orderId: unknown, motivo: unknown): Promise<{ ok: boolean; erro?: string }> {
  if (!uuid(orderId)) return { ok: false, erro: 'invalido' }
  const m = typeof motivo === 'string' ? motivo.trim() : ''
  if (m.length < 3 || m.length > 300) return { ok: false, erro: 'motivo' }
  const supabase = await createClient()
  const { error } = await supabase.rpc('release_order', { p_order: orderId, p_reason: m })
  if (!error) return { ok: true }
  // 23514 é a recusa de regra: a carga já está com ele. Vale uma mensagem própria, porque a saída existe
  // (combinar no chat) e a pessoa precisa saber disso.
  return { ok: false, erro: error.code === '23514' ? 'a_bordo' : 'falhou' }
}
