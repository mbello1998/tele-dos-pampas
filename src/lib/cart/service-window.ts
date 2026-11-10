// Horário de serviço do município (06:00 a 00:00), lido de public.is_within_service_hours: a MESMA função que o
// quote_order consulta. Uma só fonte de verdade: a tela nunca diz "aberta" para um pedido que o servidor recusa.
// Falha FECHADO: erro da consulta (ou configuração ausente, que a função trata como erro) vira "fechado", nunca "aberto".
import type { SupabaseClient } from '@supabase/supabase-js'

export type ServiceWindows = ReadonlyMap<string, boolean>

export async function loadServiceWindows(
  supabase: Pick<SupabaseClient, 'rpc'>,
  cities: Iterable<string>,
  at: Date,
): Promise<ServiceWindows> {
  const out = new Map<string, boolean>()
  await Promise.all(
    [...new Set(cities)].map(async (city) => {
      const { data, error } = await supabase.rpc('is_within_service_hours', {
        p_city: city,
        p_kind: 'food',
        p_at: at.toISOString(),
      })
      if (error) console.error('[catalogo] is_within_service_hours falhou, tratando como fechado:', error.code ?? 'sem código')
      out.set(city, !error && data === true)
    }),
  )
  return out
}
