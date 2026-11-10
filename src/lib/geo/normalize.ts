const STREET_TYPES = [
  'rua',
  'avenida',
  'av',
  'travessa',
  'beco',
  'estrada',
  'calle',
  'camino',
  'pasaje',
]

const LEADING_TYPE = new RegExp(`^(?:${STREET_TYPES.join('|')})\\.?\\s+`)
const COMBINING_MARKS = /[̀-ͯ]/g

/**
 * Lowercases, strips diacritics and the leading street-type word, so that
 * "Avenida São João Batista do Quaraí" becomes "sao joao batista do quarai".
 */
export function normalizeStreetName(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
  const stripped = base.replace(LEADING_TYPE, '')
  return stripped.length > 0 ? stripped : base
}
