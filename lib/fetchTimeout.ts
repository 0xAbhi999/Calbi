/**
 * `fetch` with a hard timeout.
 *
 * The AI grading / assistant / resume endpoints call an upstream LLM. A hung
 * upstream (slow or down) used to leave request handlers dangling forever,
 * which — multiplied by thousands of concurrent candidates — exhausts the
 * server's connection pool and event loop. Every outbound call now has a
 * ceiling: on timeout the caller's existing catch falls back to the local
 * heuristic engine, so a slow model degrades scores-to-heuristic instead of
 * hanging the request.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}
