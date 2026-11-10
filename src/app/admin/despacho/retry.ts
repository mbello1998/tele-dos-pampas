/**
 * Postgres aborts one side of a deadlock with SQLSTATE 40P01 (after about a second). The known case: a courier
 * changing their radius while a fleet owner lowers the maximum; the comments on both triggers say callers must
 * retry. The invariant survives the abort, so the operator should never see it: run again, ONCE. A second
 * 40P01 is a real problem and is surfaced.
 *
 * Handles both shapes a caller can meet: a thrown error (pg, fetch wrappers) and a returned `{ error }`
 * (supabase-js never throws on a database error).
 */
const DEADLOCK = '40P01'
const RETRY_DELAY_MS = 50

const isDeadlock = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === DEADLOCK

const returnedDeadlock = (r: unknown): boolean =>
  typeof r === 'object' && r !== null && isDeadlock((r as { error?: unknown }).error)

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS))

export async function withDeadlockRetry<T>(fn: () => Promise<T>): Promise<T> {
  let first: T
  try {
    first = await fn()
  } catch (e) {
    if (!isDeadlock(e)) throw e
    await pause()
    return fn()
  }
  if (!returnedDeadlock(first)) return first
  await pause()
  return fn()
}
