import { NextResponse } from 'next/server'
import { getUserByEmail, updateUserLogin, getLatestAssessmentResultForStudent, getProfileById } from '@/lib/db'
import { verifyPassword } from '@/lib/auth'
import { isProfileComplete } from '@/lib/validate'
import { getServerClient } from '@/lib/supabaseServer'
import { fetchProfile, hasAssessmentResult, supabaseSignIn } from '@/lib/persist'
import { checkRateLimit } from '@/lib/rateLimit'

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const email = (body.email || '').toString().trim()
    const password = (body.password || '').toString()
    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 })
    }
    if (!password || password.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters.' }, { status: 400 })
    }
    // Brute-force backstop, keyed per EMAIL (not per IP) so a whole college
    // behind one NAT IP logging in at exam start is never throttled, while a
    // targeted attack on a single account is.
    const rl = checkRateLimit(`login:${email.toLowerCase()}`, 10, 60_000)
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many sign-in attempts — please wait a minute and try again.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      )
    }

    // Supabase mode: verify credentials against Supabase Auth.
    const sb = getServerClient()
    if (sb) {
      try {
        const auth = await supabaseSignIn(sb, { email, password })
        const hasAssessment = await hasAssessmentResult(sb, auth.user.id)
        const profile = await fetchProfile(sb, auth.user.id)
        return NextResponse.json({
          access_token: auth.access_token,
          refresh_token: auth.refresh_token,
          expires_in: 900,
          user: {
            id: auth.user.id,
            email: auth.user.email,
            role: 'student',
            institution_id: 'inst_iitm',
            // The name the candidate set on their profile page is authoritative
            // — never prefer the email-derived auth username over it.
            name: profile?.full_name?.trim() || auth.user.name || auth.user.email.split('@')[0],
          },
          has_assessment: hasAssessment,
          // Onboarded = the user actually completed the onboarding form (full
          // profile loaded, not just a signup-seeded name/email). Lets the
          // client send true returners to the dashboard instead of /onboarding.
          has_onboarding: isProfileComplete(profile),
          supabase: true,
        })
      } catch (e: any) {
        return NextResponse.json({ error: e?.message || 'Invalid credentials.' }, { status: 401 })
      }
    }

    // Local demo mode.
    const user = getUserByEmail(email)
    if (!user) {
      return NextResponse.json({ error: 'Account not found. Please sign up first.' }, { status: 404 })
    }
    if (!verifyPassword(password, user.password_hash)) {
      return NextResponse.json({ error: 'Invalid password.' }, { status: 401 })
    }
    updateUserLogin(user.id)
    const profile = getProfileById(user.id)
    return NextResponse.json({
      access_token: 'jwt_' + user.id,
      refresh_token: 'refresh_' + user.id,
      expires_in: 900,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        institution_id: user.institution_id,
        // Prefer the profile's full name (chosen on the profile page) over the
        // account name seeded from the email at signup.
        name: profile?.full_name?.trim() || user.name || user.email.split('@')[0],
      },
      has_assessment: !!getLatestAssessmentResultForStudent(user.id),
      has_onboarding: isProfileComplete(profile),
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Sign in failed.' }, { status: 500 })
  }
}
