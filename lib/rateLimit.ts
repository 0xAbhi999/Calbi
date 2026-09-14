/**
 * In-process fixed-window rate limiter.
 *
 * First line of defence *inside* the app (the self-hosted Kong gateway in the
 * docs is not wired to the running code). This is per-Node-process (per PM2
 * worker), so the effective limit multiplies by worker count — set the numbers
 * generously for the whole box and treat this as burst protection, not an
 * accounting system. For a single shared limit across workers, front the app
 * with nginx (`limit_req` in infra/nginx.conf) or point `checkRateLimit` at a
 * Redis/central store.
 *
 * Pure and dependency-free so it is unit-testable in Node.
 */

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  /** Seconds the caller should wait before retrying (0 when allowed). */
  retryAfterSec: number
}

interface Bucket {
  count: number
  windowStart: number
}

const buckets = new Map<string, Bucket>()
const MAX_TRACKED = 20000 // bound memory: drop oldest when exceeded

function pruneIfNeeded(now: number): void {
  if (buckets.size <= MAX_TRACKED) return
  for (const [key, b] of buckets) {
    if (now - b.windowStart > 60_000) buckets.delete(key)
  }
}

/**
 * Fixed-window check. `limit` requests are allowed per `windowMs` per `key`
 * (typically an IP or IP+route). `now` is injectable for tests.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  pruneIfNeeded(now)
  let b = buckets.get(key)
  if (!b || now - b.windowStart >= windowMs) {
    b = { count: 0, windowStart: now }
    buckets.set(key, b)
  }
  b.count += 1
  if (b.count > limit) {
    const elapsed = now - b.windowStart
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - elapsed) / 1000))
    return { allowed: false, remaining: 0, retryAfterSec }
  }
  return { allowed: true, remaining: Math.max(0, limit - b.count), retryAfterSec: 0 }
}

/** Reset all buckets (test seam). */
export function resetRateLimits(): void {
  buckets.clear()
}

/**
 * Best-effort client IP for a Next.js request. Trusts the left-most
 * `x-forwarded-for` hop only when behind our own proxy (nginx), and falls back
 * to `x-real-ip`. Never trusts arbitrary headers from the public internet.
 */
export function getClientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  const real = req.headers.get('x-real-ip')
  if (real) return real.trim()
  return 'unknown'
}
