// Seed / sync the local JSON store (calibiai_db.json + the runtime file) into
// Supabase. Run once from the deploy host (or anywhere with the service-role
// key) to make the curated candidates real Postgres rows:
//
//   SUPABASE_SERVICE_ROLE_KEY=… NEXT_PUBLIC_SUPABASE_URL=… \
//     npm run seed:supabase            # apply
//     npm run seed:supabase -- --dry   # show what would be written
//
// Idempotent: every row's UUID is derived from its local id, so re-running
// updates the same rows. The admin dashboard can also trigger this in-process
// via POST /api/admin/sync (button on /admin) — this script is for CI/ops.
import fs from 'fs'
import path from 'path'

import { getDB } from '../lib/db.ts'
import { getServerClient } from '../lib/supabaseServer.ts'
import { applySeedPlan, buildSeedPlan, describePlan } from '../lib/supabaseSeed.ts'

/** Minimal .env loader (no dependency) — .env.local wins over .env. */
function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    const full = path.join(process.cwd(), file)
    if (!fs.existsSync(full)) continue
    for (const line of fs.readFileSync(full, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
      if (!m) continue
      const key = m[1]
      let value = m[2].trim().replace(/^["']|["']$/g, '')
      if (process.env[key] === undefined) process.env[key] = value
    }
  }
}

async function main() {
  loadEnv()
  const dry = process.argv.includes('--dry') || process.argv.includes('--dry-run')

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('✗ SUPABASE_SERVICE_ROLE_KEY is not set — seeding needs the service role (it creates auth users).')
    process.exit(2)
  }
  const client = getServerClient()
  if (!client) {
    console.error('✗ Supabase is not configured (set NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY/SUPABASE_SERVICE_ROLE_KEY).')
    process.exit(2)
  }

  const db = getDB()
  const plan = buildSeedPlan(db)
  console.log(`Plan: ${describePlan(plan)}`)
  if (!plan.candidates.length) {
    console.log('Nothing to seed — the local store has no profiles/users.')
    return
  }

  if (dry) {
    for (const row of plan.rows.filter(r => r.table === 'auth')) console.log(`  would create auth user ${row.email}`)
    for (const row of plan.rows.filter(r => r.table === 'profiles')) console.log(`  would upsert profile ${row.id} <${row.email}>`)
    console.log('Dry run — nothing was written.')
    return
  }

  const report = await applySeedPlan(client, plan, (msg) => console.log(msg))
  console.log('')
  console.log(report.ok ? '✓ Seed complete.' : `⚠ Seed finished with ${report.failures.length} failure(s).`)
  if (report.reusedAccounts) console.log(`  ${report.reusedAccounts} auth account(s) already existed and were reused.`)
  if (report.feedbackTableMissing) console.log('  Run supabase/migrations/0004_feedback_submissions.sql to store feedback.')
  if (report.failures.length) {
    console.log('  Failures:')
    for (const f of report.failures) console.log(`    - ${f.table} ${f.id}: ${f.error}`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('✗ Seed failed:', e?.message || e)
  process.exit(1)
})
