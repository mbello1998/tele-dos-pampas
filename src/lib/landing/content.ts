// Conteúdo da landing: tudo o que a página diz vem de `settings`, nunca do componente.
// Este módulo é puro (sem rede, sem env) para poder ser testado em Node; a leitura do banco
// fica em ./load.ts.
export type Locale = 'pt-BR' | 'es-UY'
export const LOCALES: readonly Locale[] = ['pt-BR', 'es-UY']
export const DEFAULT_LOCALE: Locale = 'pt-BR'

/** Chaves de `settings` que a landing consome. Todas `is_public = true` (migração 0013). */
export const LANDING_KEYS = {
  headline: 'landing_headline', // já existe no seed.sql
  subheadline: 'landing_subheadline',
  ctaLabel: 'landing_cta_label',
  ctaHref: 'landing_cta_href', // texto simples: destino do botão, igual nos dois idiomas
  cityQuarai: 'landing_city_quarai',
  cityArtigas: 'landing_city_artigas',
  hoursNotice: 'landing_hours_notice',
  supportLabel: 'landing_support_label',
  supportPhone: 'support_phone', // texto simples, opcional; vazio esconde o bloco
  gridTitle: 'landing_grid_title',
  gridText: 'landing_grid_text',
  gridAlt: 'landing_grid_alt',
  bridgeLabel: 'landing_bridge_label',
  servicesTitle: 'landing_services_title',
  serviceFood: 'landing_service_food',
  serviceCourier: 'landing_service_courier',
  serviceRide: 'landing_service_ride',
  closingTitle: 'landing_closing_title',
} as const

export type SettingRow = { key: string; value: unknown }
export type ServiceCopy = { title: string; text: string }

export type LandingContent = {
  headline: string
  subheadline: string
  ctaLabel: string
  ctaHref: string
  cityQuarai: string
  cityArtigas: string
  hoursNotice: string
  supportLabel: string
  supportPhone: string | null
  gridTitle: string
  gridText: string
  gridAlt: string
  bridgeLabel: string
  servicesTitle: string
  services: { food: ServiceCopy; courier: ServiceCopy; ride: ServiceCopy }
  closingTitle: string
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Escolhe o idioma pedido; se a tradução não existir, usa pt-BR. */
function localized(key: string, value: unknown, locale: Locale): unknown {
  if (!isObject(value)) throw new Error(`settings.${key}: esperado objeto por idioma, veio ${typeof value}`)
  const picked = value[locale] ?? value[DEFAULT_LOCALE]
  if (picked === undefined) throw new Error(`settings.${key}: sem texto em ${locale} nem em ${DEFAULT_LOCALE}`)
  return picked
}

function text(key: string, value: unknown, locale: Locale): string {
  const picked = localized(key, value, locale)
  if (typeof picked !== 'string' || picked.trim() === '') throw new Error(`settings.${key}: texto vazio ou inválido`)
  return picked
}

function service(key: string, value: unknown, locale: Locale): ServiceCopy {
  const picked = localized(key, value, locale)
  if (!isObject(picked) || typeof picked.title !== 'string' || typeof picked.text !== 'string') {
    throw new Error(`settings.${key}: esperado { title, text }`)
  }
  return { title: picked.title, text: picked.text }
}

/** O destino do botão é editável sem deploy, então só aceita âncora, caminho do site ou https. */
function href(key: string, value: unknown): string {
  if (typeof value !== 'string' || !/^(#[\w-]+|\/(?!\/)[^\s]*|https:\/\/[^\s]+)$/.test(value)) {
    throw new Error(`settings.${key}: destino inválido (use #âncora, /caminho ou https://)`)
  }
  return value
}

export function parseLandingContent(rows: SettingRow[], locale: Locale): LandingContent {
  const byKey = new Map(rows.map((r) => [r.key, r.value]))
  const need = (k: string) => {
    if (!byKey.has(k)) throw new Error(`settings.${k}: chave ausente (rode a migração 0013 e o seed)`)
    return byKey.get(k)
  }
  const k = LANDING_KEYS
  const phone = byKey.get(k.supportPhone)
  return {
    headline: text(k.headline, need(k.headline), locale),
    subheadline: text(k.subheadline, need(k.subheadline), locale),
    ctaLabel: text(k.ctaLabel, need(k.ctaLabel), locale),
    ctaHref: href(k.ctaHref, need(k.ctaHref)),
    cityQuarai: text(k.cityQuarai, need(k.cityQuarai), locale),
    cityArtigas: text(k.cityArtigas, need(k.cityArtigas), locale),
    hoursNotice: text(k.hoursNotice, need(k.hoursNotice), locale),
    supportLabel: text(k.supportLabel, need(k.supportLabel), locale),
    supportPhone: typeof phone === 'string' && phone.trim() !== '' ? phone.trim() : null,
    gridTitle: text(k.gridTitle, need(k.gridTitle), locale),
    gridText: text(k.gridText, need(k.gridText), locale),
    gridAlt: text(k.gridAlt, need(k.gridAlt), locale),
    bridgeLabel: text(k.bridgeLabel, need(k.bridgeLabel), locale),
    servicesTitle: text(k.servicesTitle, need(k.servicesTitle), locale),
    services: {
      food: service(k.serviceFood, need(k.serviceFood), locale),
      courier: service(k.serviceCourier, need(k.serviceCourier), locale),
      ride: service(k.serviceRide, need(k.serviceRide), locale),
    },
    closingTitle: text(k.closingTitle, need(k.closingTitle), locale),
  }
}
