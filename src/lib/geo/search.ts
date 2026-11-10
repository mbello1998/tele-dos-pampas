import { normalizeStreetName } from './normalize'
import type { Street, StreetDataset } from './types'

export type StreetHit = Street & { score: number }

const DEFAULT_LIMIT = 8

/** A phone keyboard often leaves a trailing period or comma; it is never part of a street name. */
const TRAILING_PUNCTUATION = /[\s.,;:!?]+$/

// Scores: tiers are far apart so a better tier always beats a worse one.
const SCORE_EXACT = 110
const SCORE_PREFIX = 100
const SCORE_WORD_PREFIX = 80
const SCORE_SUBSTRING = 60
const SCORE_FUZZY_BASE = 45
const FUZZY_PENALTY_PER_EDIT = 10
const FUZZY_PENALTY_LATER_WORD = 5

/** Edits tolerated for a query of this length: none for 1-2 letters (pure noise), capped at 2. */
function maxEdits(queryLength: number): number {
  if (queryLength < 3) return 0
  return queryLength < 6 ? 1 : 2
}

// Reused DP column; grown on demand so a keystroke does not allocate.
let column = new Int32Array(64)

/**
 * Smallest edit distance between `query` and any prefix of `text` taken from
 * `start`, looking at no more than query.length + max characters. Returns
 * max + 1 as soon as it is certain the distance exceeds `max`.
 */
function prefixDistance(query: string, text: string, start: number, max: number): number {
  const m = query.length
  if (column.length < m + 1) column = new Int32Array(m + 1)
  for (let i = 0; i <= m; i++) column[i] = i
  let best = m
  const end = Math.min(text.length, start + m + max)
  for (let j = start; j < end; j++) {
    const tc = text.charCodeAt(j)
    let diag = column[0]
    column[0] = j - start + 1
    let rowMin = column[0]
    for (let i = 1; i <= m; i++) {
      const up = column[i]
      const cost = query.charCodeAt(i - 1) === tc ? 0 : 1
      const v = Math.min(diag + cost, up + 1, column[i - 1] + 1)
      column[i] = v
      diag = up
      if (v < rowMin) rowMin = v
    }
    if (column[m] < best) best = column[m]
    if (rowMin > max) break
  }
  return best
}

function scoreName(name: string, q: string, edits: number): number {
  if (name === q) return SCORE_EXACT
  if (name.startsWith(q)) return SCORE_PREFIX

  let best = 0
  const substringAt = name.indexOf(q)
  if (substringAt > 0) {
    best = name.charCodeAt(substringAt - 1) === 32 ? SCORE_WORD_PREFIX : SCORE_SUBSTRING
    if (best === SCORE_WORD_PREFIX) return best
  }

  if (edits > 0) {
    // Fuzzy match anchored at the start of each word, so "gonzalves" finds
    // "bento goncalves" without scanning every character offset.
    let i = 0
    while (i < name.length) {
      const d = prefixDistance(q, name, i, edits)
      if (d <= edits) {
        const s = SCORE_FUZZY_BASE - d * FUZZY_PENALTY_PER_EDIT - (i > 0 ? FUZZY_PENALTY_LATER_WORD : 0)
        if (s > best) best = s
      }
      const space = name.indexOf(' ', i)
      if (space === -1) break
      i = space + 1
    }
  }
  return best
}

type Candidate = { street: Street; score: number }

/**
 * Searches the streets of every dataset at once. Matching runs over the
 * accent-free, street-type-free form: exact/prefix/word-prefix/substring
 * tiers, then edit distance (max 2) anchored at word starts. Every hit keeps
 * its `city` and `country`, since the same name can exist on both sides.
 */
export function searchStreets(query: string, datasets: StreetDataset[], limit: number = DEFAULT_LIMIT): StreetHit[] {
  const q = normalizeStreetName(query.replace(TRAILING_PUNCTUATION, ''))
  if (q.length === 0 || limit <= 0) return []
  const edits = maxEdits(q.length)

  const found: Candidate[] = []
  for (const dataset of datasets) {
    for (const street of dataset.streets) {
      const score = scoreName(street.nameNormalized, q, edits)
      if (score > 0) found.push({ street, score })
    }
  }

  found.sort(
    (a, b) =>
      b.score - a.score ||
      a.street.nameNormalized.length - b.street.nameNormalized.length ||
      (a.street.nameNormalized < b.street.nameNormalized ? -1 : a.street.nameNormalized > b.street.nameNormalized ? 1 : 0),
  )

  const top = found.length > limit ? found.slice(0, limit) : found
  return top.map(({ street, score }) => ({ ...street, score }))
}
