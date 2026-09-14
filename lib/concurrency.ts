/**
 * Minimal semaphore / concurrency limiter.
 *
 * The assessment has a few endpoints that can consume unbounded resources:
 * `/api/user/assessment/runtests` forks a `node`/`python3` subprocess per call
 * (CPU + process-table pressure) and `/api/user/resume/analyze` runs PDF/DOCX
 * parsing plus an LLM call. Under a 5000-candidate burst, unrestricted
 * concurrency on those is exactly what takes a box down (fork bombs, OOM).
 *
 * This module caps how many of those heavyweight operations run at once inside
 * ONE Node process (per PM2 worker). Requests beyond the cap are rejected
 * fast with HTTP 429 + Retry-After instead of being queued indefinitely, so
 * the rest of the assessment keeps working.
 */

export interface ConcurrencyLimiter {
  /** Reserve a slot if one is free (returns true). Never blocks. */
  tryAcquire(): boolean
  /** Release a previously acquired slot. */
  release(): void
  /** How many slots are currently in use. */
  active(): number
  /** The configured capacity. */
  max(): number
}

export function createLimiter(max: number): ConcurrencyLimiter {
  let active = 0
  return {
    tryAcquire() {
      if (active >= max) return false
      active += 1
      return true
    },
    release() {
      if (active > 0) active -= 1
    },
    active() {
      return active
    },
    max() {
      return max
    },
  }
}
