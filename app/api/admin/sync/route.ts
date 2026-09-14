import { NextResponse } from 'next/server'
import { isAdminRequest } from '@/lib/adminAuth'
import { getDB } from '@/lib/db'
import { getServerClient } from '@/lib/supabaseServer'
import { applySeedPlan, buildSeedPlan, describePlan } from '@/lib/supabaseSeed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/sync — write the local candidates into Supabase.
 *
 * The curated/demo candidates in `calibiai_db.json` carry ids like `u_84368932`
 * that are not valid UUIDs and were never inserted into Postgres, so a
 * Supabase-only view of the data can never show them. This endpoint (admin
 * cookie required, service-role key required) turns them into real rows: one
 * auth user per candidate, then profile + assessment sessions/results + resume
 * analyses + feedback.
 *
 * Idempotent — safe to run repeatedly. `GET` reports what a run would do
 * without writing anything.
 */
export async function GET(req: Request) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const sb = getServerClient()
    const plan = buildSeedPlan(getDB())
    return NextResponse.json({
      dryRun: true,
      summary: plan.summary,
      candidates: plan.candidates.length,
      description: describePlan(plan),
      canSync: !!sb && !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      hint: !sb
        ? 'Supabase is not configured on this host.'
        : !process.env.SUPABASE_SERVICE_ROLE_KEY
          ? 'Set SUPABASE_SERVICE_ROLE_KEY on the host to write candidates into Supabase.'
          : undefined,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Could not build the sync plan.' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const sb = getServerClient()
  if (!sb) {
    return NextResponse.json({ error: 'Supabase is not configured on this host.' }, { status: 400 })
  }
  if (!(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim()) {
    return NextResponse.json(
      {
        error:
          'Syncing needs SUPABASE_SERVICE_ROLE_KEY (it has to create auth accounts). Set it on the host and restart the app.',
      },
      { status: 400 },
    )
  }
  try {
    const plan = buildSeedPlan(getDB())
    const report = await applySeedPlan(sb, plan)
    return NextResponse.json({
      ok: report.ok,
      summary: report.summary,
      candidates: plan.candidates.length,
      reusedAccounts: report.reusedAccounts,
      feedbackTableMissing: report.feedbackTableMissing || undefined,
      failures: report.failures,
      message: report.ok
        ? `Synced ${describePlan(plan)} into Supabase.`
        : `Synced with ${report.failures.length} failure(s) — see the details below.`,
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Sync failed.' }, { status: 500 })
  }
}
