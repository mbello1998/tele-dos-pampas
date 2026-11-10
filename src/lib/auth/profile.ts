// Leitura da linha de `profiles` do próprio usuário. Sem next/headers: recebe o cliente já montado.
import type { SupabaseClient } from '@supabase/supabase-js'
import { isLocale } from '@/lib/i18n'
import { USER_ROLES, type City, type Country, type Currency, type Profile, type ProfileStatus, type UserRole } from './types'

export const PROFILE_COLUMNS = 'id, role, status, full_name, phone, locale, currency_pref, home_city, country'

type Row = {
  id: string
  role: string
  status: string
  full_name: string | null
  phone: string | null
  locale: string
  currency_pref: string
  home_city: string | null
  country: string | null
}

/** Linha -> Profile. Valor fora do esperado vira erro (o banco tem CHECK; se isto falhar, o contrato quebrou). */
export function toProfile(row: Row): Profile {
  if (!(USER_ROLES as readonly string[]).includes(row.role)) throw new Error(`profiles.role inesperado: ${row.role}`)
  if (!['active', 'pending', 'blocked'].includes(row.status)) throw new Error(`profiles.status inesperado: ${row.status}`)
  return {
    id: row.id,
    role: row.role as UserRole,
    status: row.status as ProfileStatus,
    fullName: row.full_name,
    phone: row.phone,
    locale: isLocale(row.locale) ? row.locale : 'pt-BR',
    currencyPref: (row.currency_pref === 'UYU' ? 'UYU' : 'BRL') as Currency,
    homeCity: (row.home_city as City | null) ?? null,
    country: (row.country as Country | null) ?? null,
  }
}

/**
 * O perfil do usuário `userId`, lido com a sessão DELE (RLS: profiles_select_own, que vale também para
 * pending e blocked, justamente para a tela de espera poder dizer o que está acontecendo).
 */
export async function fetchOwnProfile(supabase: SupabaseClient, userId: string): Promise<Profile | null> {
  const { data, error } = await supabase.from('profiles').select(PROFILE_COLUMNS).eq('id', userId).maybeSingle()
  if (error) throw new Error(`profiles: ${error.message}`)
  return data ? toProfile(data as Row) : null
}
