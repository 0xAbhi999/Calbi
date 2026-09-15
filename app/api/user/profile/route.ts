import { NextResponse } from 'next/server'
import { findProfileByPrn, getProfileById, saveProfile } from '@/lib/db'
import { getClientForRequest } from '@/lib/supabaseServer'
import { persistProfileDetailed, fetchProfile, syncWarning, PROFILE_SELECT } from '@/lib/persist'
import {
  GENDER_OPTIONS,
  PHONE_DIGITS,
  PRN_MAX_LENGTH,
  PRN_MIN_LENGTH,
  isGender,
  isValidPhone,
  isValidPrn,
  normalizePhone,
  normalizePrn,
} from '@/lib/validate'

/** Fields a partial update may touch — everything else is ignored. */
const PARTIAL_FIELDS = [
  'full_name', 'prn', 'phone', 'dob', 'gender', 'degree', 'college',
  'graduation_year', 'cgpa', 'skills', 'linkedin_url', 'github_url', 'ai_avatar',
] as const

const PRN_ERROR = `PRN must be ${PRN_MIN_LENGTH}–${PRN_MAX_LENGTH} letters/numbers, or left blank.`

/**
 * A PRN identifies one student inside a college, so two accounts may not claim
 * the same one. Blank is always allowed (the field is optional) and a student
 * re-saving their own PRN is allowed.
 *
 * Best-effort: with the caller's own JWT the read policy (`auth.uid() = id`)
 * only exposes this student's row, so a clash belonging to *someone else* is
 * caught by the `profiles_prn_unique_idx` unique index instead — the resulting
 * 23505 is translated into the same message by `prnConflict()`. Only a
 * service-role key can pre-check every row.
 */
async function prnAlreadyTaken(sb: any, prn: string, userId: string): Promise<boolean> {
  if (!prn) return false
  if (sb) {
    try {
      const { data } = await sb
        .from('profiles')
        .select('id')
        .eq('prn', prn)
        .neq('id', userId)
        .limit(1)
      if (data && data.length > 0) return true
    } catch {
      /* fall through to the local check below */
    }
  }
  return Boolean(findProfileByPrn(prn, userId))
}

/** `23505` on profiles is the PRN unique index (the only unique index besides the PK). */
function prnConflict(outcome: { ok: boolean; code?: string }): boolean {
  return !outcome.ok && outcome.code === '23505'
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url)
    const userId = url.searchParams.get('user_id') || ''
    if (!userId) return NextResponse.json({ error: 'Missing user_id' }, { status: 400 })
    // As the caller: the profiles read policy is `auth.uid() = id`, so an
    // anonymous server client (no SUPABASE_SERVICE_ROLE_KEY) sees nothing and
    // the student looked un-onboarded even though their row was in Postgres.
    const sb = getClientForRequest(req)
    if (sb) {
      const { data } = await sb.from('profiles').select(PROFILE_SELECT).eq('id', userId).maybeSingle()
      if (data) return NextResponse.json({ profile: data, supabase: true })
    }
    const profile = getProfileById(userId)
    return NextResponse.json({ profile })
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Failed to fetch profile' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const userId = body.user_id || body.id
    // Writes go out AS the signed-in student (their access token is forwarded
    // by lib/apiFetch.ts), because every self-owned table is RLS-scoped to
    // `auth.uid() = id`. The previous anon-key client was rejected by RLS and
    // the onboarding details never reached Postgres.
    const sb = getClientForRequest(req)

    // Partial update (inline name edit, avatar save): merge the provided
    // fields into the existing row instead of requiring the full form again.
    if (body.partial === true) {
      if (!userId) return NextResponse.json({ error: 'Missing user_id' }, { status: 400 })
      const base: any = sb ? await fetchProfile(sb, userId) : null
      const local = getProfileById(userId)
      const existing = base || local
      if (!existing) return NextResponse.json({ error: 'Profile not found.' }, { status: 404 })

      const merged: any = { ...existing, email: existing.email || body.email || '', id: userId }
      for (const f of PARTIAL_FIELDS) {
        if (body[f] !== undefined) merged[f] = body[f]
      }
      if (merged.phone !== undefined && merged.phone !== null && merged.phone !== '') {
        merged.phone = normalizePhone(merged.phone)
      }
      if (merged.ai_avatar !== undefined && !(merged.ai_avatar && typeof merged.ai_avatar === 'object')) {
        merged.ai_avatar = null
      }
      // PRN is optional; when present it must be a plausible registration number
      // that no other student already claims.
      merged.prn = normalizePrn(merged.prn)
      if (!isValidPrn(merged.prn)) {
        return NextResponse.json({ error: PRN_ERROR }, { status: 400 })
      }
      if (await prnAlreadyTaken(sb, merged.prn, userId)) {
        return NextResponse.json(
          { error: 'That PRN is already registered to another account.' },
          { status: 409 },
        )
      }
      merged.updated_at = new Date().toISOString()

      saveProfile(merged)
      const outcome = sb ? await persistProfileDetailed(sb, merged) : null
      if (outcome && prnConflict(outcome)) {
        return NextResponse.json(
          { error: 'That PRN is already registered to another account.' },
          { status: 409 },
        )
      }
      return NextResponse.json({
        profile: merged,
        saved: true,
        supabase: !!outcome?.ok,
        sync_warning: syncWarning(outcome),
      })
    }

    // Full onboarding / edit-form save: strict validation as before.
    // Phone: exactly 10 digits (country code / trunk prefix are stripped).
    const phone = normalizePhone(body.phone)
    if (!isValidPhone(phone)) {
      return NextResponse.json(
        { error: `Mobile number must be exactly ${PHONE_DIGITS} digits.` },
        { status: 400 },
      )
    }
    // Gender: fixed dropdown — Male / Female / Other only.
    const gender = (body.gender || '').toString()
    if (!isGender(gender)) {
      return NextResponse.json(
        { error: `Gender must be one of: ${GENDER_OPTIONS.join(', ')}.` },
        { status: 400 },
      )
    }
    // PRN: optional, but validated and unique when supplied.
    const prn = normalizePrn(body.prn)
    if (!isValidPrn(prn)) {
      return NextResponse.json({ error: PRN_ERROR }, { status: 400 })
    }
    if (userId && await prnAlreadyTaken(sb, prn, String(userId))) {
      return NextResponse.json(
        { error: 'That PRN is already registered to another account.' },
        { status: 409 },
      )
    }
    const profile = {
      id: userId,
      email: body.email || '',
      full_name: body.full_name || '',
      prn,
      phone,
      dob: body.dob || '',
      gender,
      degree: body.degree || '',
      college: body.college || '',
      graduation_year: Number(body.graduation_year) || 0,
      cgpa: Number(body.cgpa) || 0,
      skills: body.skills || '',
      linkedin_url: body.linkedin_url || '',
      github_url: body.github_url || '',
      ai_avatar: body.ai_avatar && typeof body.ai_avatar === 'object' ? body.ai_avatar : null,
      updated_at: new Date().toISOString(),
    }
    saveProfile(profile)
    // Mirror everything (mobile, gender, degree, …) into Supabase when configured.
    const outcome = sb ? await persistProfileDetailed(sb, profile) : null
    if (outcome && prnConflict(outcome)) {
      return NextResponse.json(
        { error: 'That PRN is already registered to another account.' },
        { status: 409 },
      )
    }
    return NextResponse.json({
      profile,
      saved: true,
      supabase: !!outcome?.ok,
      // Supabase is configured but the row did not land — say so instead of
      // reporting a clean save (see lib/persist.ts syncWarning).
      sync_warning: syncWarning(outcome),
    })
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Failed to save profile' }, { status: 500 })
  }
}
