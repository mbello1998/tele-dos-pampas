import type { Locale } from '@/lib/i18n'
import type { Currency } from '@/lib/money/format'

export type { Locale, Currency }
export type UserRole = 'client' | 'courier' | 'merchant' | 'fleet' | 'admin'
export type ProfileStatus = 'active' | 'pending' | 'blocked'
export type City = 'quarai' | 'artigas'
export type Country = 'BR' | 'UY'

export const USER_ROLES: readonly UserRole[] = ['client', 'courier', 'merchant', 'fleet', 'admin']

/** O mínimo para decidir acesso e rota. */
export type ProfileLite = { role: UserRole; status: ProfileStatus; fullName: string | null }

/** A linha de `profiles` do próprio usuário, em camelCase. `role` e `status` só o admin altera (guard no banco). */
export type Profile = ProfileLite & {
  id: string
  phone: string | null
  locale: Locale
  currencyPref: Currency
  homeCity: City | null
  country: Country | null
}

/** Quem está logado: o usuário verificado pelo servidor de autenticação e o perfil lido do banco. */
export type Session = {
  user: { id: string; email: string | null }
  profile: Profile
}
