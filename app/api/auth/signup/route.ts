import { NextResponse } from 'next/server'
import { getUserByEmail, createUser } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { getServerClient } from '@/lib/supabaseServer'
import { persistProfile, supabaseSignUp } from '@/lib/persist'
import { checkRateLimit } from '@/lib/rateLimit'

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const email = (body.email || '').toString().trim()
    const password = (body.password || '').toString()
    const role = (body.role || 'student').toString()
    const fullName = (body.full_name || email.split('@')[0]).toString()
    if (!email || !email.includes('@')) {
      return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 })
    }
    if (password.length < 6) {
      return NextResponse.json({ error: 'Password must be at least 6 characters.' }, { status: 400 })
    }
    // Anti-spam backstop, keyed per EMAIL (not per IP) for the same NAT reason
    // as login: a college's shared IP must never throttle real sign-ups.
    const rl = checkRateLimit(`signup:${email.toLowerCase()}`, 5, 60_000)
    if (!rl.allowed) {
      return NextResponse.json(
        { error: 'Too many sign-up attempts for this email — please wait a minute.' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      )
    }

    // Supabase mode: email + password live in Supabase Auth, profile row mirrors onboarding.
    const sb = getServerClient()
    if (sb) {
      try {
        const auth = await supabaseSignUp(sb, { email, password, full_name: fullName, role })
        await persistProfile(sb, { id: auth.user.id, email, full_name: fullName })
        return NextResponse.json({
          user: {
            id: auth.user.id,
            email: auth.user.email,
            role,
            institution_id: body.institution_id || 'inst_iitm',
            name: auth.user.name || fullName,
          },
          access_token: auth.access_token,
          refresh_token: auth.refresh_token,
          supabase: true,
          message: 'Account created successfully.',
        }, { status: 201 })
      } catch (e: any) {
        return NextResponse.json({ error: e?.message || 'Sign up failed.' }, { status: 400 })
      }
    }

    // Local demo mode.
    const existing = getUserByEmail(email)
    if (existing) {
      return NextResponse.json({ error: 'email already exist' }, { status: 409 })
    }
    const user = createUser(email, hashPassword(password), role, body.institution_id || 'inst_iitm', fullName)
    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        institution_id: user.institution_id,
        name: user.name,
      },
      message: 'Account created successfully.',
    }, { status: 201 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Sign up failed.' }, { status: 500 })
  }
}
