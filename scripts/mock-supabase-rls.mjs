// Stand-in for Supabase PostgREST that enforces the repo's real constraints:
//   profiles:            insert/update using (auth.uid() = id)            -> 42501
//   assessment_sessions: using (auth.uid() = student_id) + FK to profiles -> 42501 / 23503
//   resume_analyses / tracking_events / assessment_results: same shape
// `auth.uid()` comes from the `sub` claim of the JWT in the Authorization
// header, exactly as PostgREST derives it. Not part of the app; started by hand
// to drive the real route handlers without a Supabase project.
import http from 'node:http'

const port = Number(process.env.PORT || 54397)
/** table -> Map<id, row> */
const rows = new Map()
const table = (t) => { if (!rows.has(t)) rows.set(t, new Map()); return rows.get(t) }

function subOf(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null // the anon key is not a user JWT
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8')).sub || null
  } catch { return null }
}

const fail = (res, code, message) => {
  res.writeHead(code === '42501' ? 400 : 409, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ code, message, details: null, hint: null }))
}

/** Which column owns the row, per the RLS policy of that table. */
const ownerOf = (t, row) => (t === 'profiles' ? row.id : row.student_id || row.user_id)

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const url = new URL(req.url, 'http://x')
    const t = (url.pathname.match(/^\/rest\/v1\/([a-z_]+)/) || [])[1]
    if (!t) return fail(res, '42P01', 'not found')
    const sub = subOf(req)

    if (req.method === 'GET') {
      const idFilter = url.searchParams.get('id')
      const wanted = idFilter?.startsWith('eq.') ? idFilter.slice(3) : null
      const excluded = idFilter?.startsWith('neq.') ? idFilter.slice(4) : null
      const visible = [...table(t).values()]
        .filter((r) => ownerOf(t, r) === sub)
        .filter((r) => (!wanted || r.id === wanted) && (!excluded || r.id !== excluded))
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Range': `0-${Math.max(0, visible.length - 1)}/*` })
      return res.end(JSON.stringify(visible))
    }

    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : null
    const incoming = Array.isArray(body) ? body : [body]
    for (const row of incoming || []) {
      const owner = ownerOf(t, row)
      // RLS: the caller may only touch their own rows.
      if (!sub || sub !== owner) {
        console.log(`[mock] ${req.method} ${t} as ${sub ? 'user ' + sub : 'ANONYMOUS'} -> 42501 (owner ${owner})`)
        return fail(res, '42501', `new row violates row-level security policy for table "${t}"`)
      }
      // FK: every student-owned table references public.profiles(id).
      if (t !== 'profiles' && !table('profiles').has(owner)) {
        console.log(`[mock] ${req.method} ${t} as user ${sub} -> 23503 (no profiles row for ${owner})`)
        return fail(res, '23503',
          `insert or update on table "${t}" violates foreign key constraint "${t}_student_id_fkey"`)
      }
    }
    for (const row of incoming) table(t).set(row.session_id && t === 'assessment_results' ? row.session_id : row.id, row)
    console.log(`[mock] ${req.method} ${t} as user ${sub} -> accepted ${incoming.length} row(s)`)
    res.writeHead(201, { 'Content-Type': 'application/json', Prefer: 'return=minimal' })
    res.end('')
  })
})

server.listen(port, '127.0.0.1', () => console.log(`[mock-supabase-rls] on http://127.0.0.1:${port}`))
