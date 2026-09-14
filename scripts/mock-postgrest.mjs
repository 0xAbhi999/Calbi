/**
 * Minimal PostgREST stand-in used to exercise the feedback/help write path
 * against a REAL supabase-js client without a Postgres instance.
 *
 * It reproduces the two failures the production bug hinged on:
 *   - POST with `Prefer: resolution=merge-duplicates` (what `.upsert()` sends)
 *     → 42501 "new row violates row-level security policy", exactly what an
 *     anon key gets on a table that only has insert + select-own policies.
 *   - an optional `MISSING_TABLE=1` mode → 42P01 for every write.
 *
 * Not part of the app; started by hand for verification.
 */
import http from 'node:http'

const port = Number(process.env.PORT || 54321)
const missingTable = process.env.MISSING_TABLE === '1'
/** Every row the server accepted, per table. */
const rows = new Map()

function tableOf(pathname) {
  const match = pathname.match(/^\/rest\/v1\/([a-z_]+)/)
  return match ? match[1] : null
}

const server = http.createServer((req, res) => {
  const table = tableOf(req.url || '')
  if (!table) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ code: '42P01', message: 'not found' }))
    return
  }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : null

    if (req.method === 'GET') {
      const stored = rows.get(table) || []
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Range': `0-${Math.max(0, stored.length - 1)}/*` })
      res.end(JSON.stringify(stored))
      return
    }

    if (missingTable) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        code: '42P01',
        message: `relation "public.${table}" does not exist`,
        details: null,
        hint: null,
      }))
      return
    }

    const prefer = String(req.headers.prefer || '')
    const isUpsert = /resolution=/.test(prefer)
    const isMerge = /resolution=merge-duplicates/.test(prefer)

    if (isMerge) {
      // ON CONFLICT DO UPDATE needs an UPDATE policy the table does not have.
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        code: '42501',
        message: `new row violates row-level security policy for table "${table}"`,
        details: 'Unauthorized',
        hint: null,
      }))
      return
    }

    const list = rows.get(table) || []
    const incoming = Array.isArray(body) ? body : [body]
    for (const row of incoming) {
      const existing = list.findIndex((r) => r.id === row.id)
      if (existing >= 0) {
        if (isUpsert) list[existing] = row // ignore-duplicates upsert: no-op merge
        else {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            code: '23505',
            message: `duplicate key value violates unique constraint "${table}_pkey"`,
            details: `Key (id)=(${row.id}) already exists.`,
            hint: null,
          }))
          return
        }
      } else {
        list.push(row)
      }
    }
    rows.set(table, list)
    res.writeHead(201, { 'Content-Type': 'application/json', Prefer: 'return=minimal' })
    res.end('')
  })
})

server.listen(port, '0.0.0.0', () => {
  console.log(`[mock-postgrest] listening on http://0.0.0.0:${port} (MISSING_TABLE=${missingTable})`)
})
