/**
 * Verifies supabase/queries/fix_admin_sync_missing_auth_users.sql against a
 * real PostgreSQL (PGlite), on BOTH shapes of Supabase's auth schema:
 *
 *   - current:  auth.identities.id uuid + unique (provider_id, provider)
 *   - older:    auth.identities.id text, primary key (provider, id)
 *
 * plus the repo's own supabase/schema.sql (profiles FK to auth.users + the
 * on_auth_user_created trigger). It first reproduces the reported failure
 * (42804 "column id is of type uuid but expression is of type text") with the
 * draft statement, then proves the shipped file: creates the 11 auth users,
 * their email identities and profile rows, stores bcrypt hashes that verify
 * with CalibiDemo@123, is idempotent, and leaves the FK intact for unknown ids.
 *
 * The auth schema here is a faithful MOCK — Supabase owns the real one — so this
 * checks the statements' types, uniqueness and FK behaviour, not GoTrue itself.
 *
 *   npm run verify:seedsql
 *
 * Exits non-zero if any check fails.
 */
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf-8')
const FIX = read('supabase/queries/fix_admin_sync_missing_auth_users.sql')

let failures = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`)
  else { failures++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`) }
}

/** Split the fix file into the numbered steps so we can run them in order. */
function step(n) {
  const start = FIX.indexOf(`-- STEP ${n} `)
  const end = FIX.indexOf(`-- STEP ${n + 1} `, start)
  const body = FIX.slice(start, end === -1 ? FIX.length : end)
  // drop the banner comment block
  return body.replace(/^--[\s\S]*?\n(?=(?:drop|create|insert|with|do|select|begin))/m, '')
}

async function build(identitiesShape) {
  const db = await PGlite.create({ extensions: { pgcrypto } })
  await db.exec(`
    create extension if not exists pgcrypto;
    create schema auth;
    create table auth.users (
      instance_id uuid,
      id uuid primary key,
      aud varchar(255), role varchar(255),
      email varchar(255),
      encrypted_password varchar(255),
      confirmation_token varchar(255),
      email_change varchar(255),
      email_change_token_new varchar(255),
      recovery_token varchar(255),
      email_confirmed_at timestamptz,
      raw_app_meta_data jsonb default '{}'::jsonb,
      raw_user_meta_data jsonb default '{}'::jsonb,
      created_at timestamptz, updated_at timestamptz,
      is_sso_user boolean not null default false
    );
    create unique index users_email_partial_key on auth.users (email) where is_sso_user = false;
    -- strictest real-world case: these token columns carry UNIQUE indexes
    create unique index users_confirmation_token_key on auth.users (confirmation_token) where confirmation_token is not null;
    create unique index users_recovery_token_key on auth.users (recovery_token) where recovery_token is not null;
    create unique index users_email_change_token_new_key on auth.users (email_change_token_new) where email_change_token_new is not null;
  `)
  if (identitiesShape === 'uuid') {
    await db.exec(`
      create table auth.identities (
        id uuid default gen_random_uuid() primary key,
        user_id uuid not null references auth.users(id) on delete cascade,
        identity_data jsonb not null,
        provider text not null,
        provider_id text,
        last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz,
        constraint identities_provider_id_provider_key unique (provider_id, provider)
      );`)
  } else {
    await db.exec(`
      create table auth.identities (
        id text not null,
        user_id uuid not null references auth.users(id) on delete cascade,
        identity_data jsonb not null,
        provider text not null,
        provider_id text,
        last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz,
        constraint identities_pkey primary key (provider, id),
        constraint identities_provider_id_provider_key unique (provider_id, provider)
      );`)
  }
  // Supabase platform stubs the repo's schema.sql depends on
  await db.exec(`
    create or replace function auth.uid() returns uuid
      language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema if not exists storage;
    create table storage.buckets (id text primary key, name text, public boolean default false);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
    alter table storage.objects enable row level security;
    create or replace function storage.foldername(name text) returns text[]
      language sql immutable as $fn$ select string_to_array(name, '/') $fn$;
  `)
  // the repo's own public schema (profiles + on_auth_user_created trigger)
  await db.exec(read('supabase/schema.sql').replace(/create extension if not exists "pgcrypto";/gi, ''))
  return db
}

const run = async (db, label, sql) => {
  try { await db.exec(sql); return { ok: true } }
  catch (e) { return { ok: false, msg: String(e.message).split('\n')[0] } }
}

/* ------------------------------------------------------------------ */
console.log(`\n=== A) reproduce the reported error (id uuid, cast to text) ===`)
{
  const db = await build('uuid')
  await db.exec(`insert into auth.users (id, email, encrypted_password) values ('df972f0a-cc01-53d6-b489-32369ef9695b','testuser@example.com','x')`)
  const r = await run(db, 'draft insert', `insert into auth.identities (id, user_id, provider_id, provider, identity_data)
    select u.id::text, u.id, 'email', 'email', '{}'::jsonb from auth.users u`)
  check('draft fails exactly as reported (42804)', !r.ok && /42804|is of type uuid but expression is of type text/.test(r.msg), r.msg)
}

console.log(`\n=== B) the corrected script, current schema (id uuid) ===`)
{
  const db = await build('uuid')
  const r1 = await run(db, 'step1', step(1))
  const r2 = await run(db, 'step2', step(2))
  const r3 = await run(db, 'step3', step(3))
  check('STEP 1 (diagnose) runs', r1.ok, r1.msg)
  check('STEP 2 (auth.users) runs', r2.ok, r2.msg)
  check('STEP 3 (auth.identities) runs', r3.ok, r3.msg)

  const users = (await db.query('select count(*)::int n from auth.users')).rows[0].n
  const ids = (await db.query('select count(*)::int n from auth.identities')).rows[0].n
  const prof = (await db.query('select count(*)::int n from public.profiles')).rows[0].n
  check('11 auth users created', users === 11, String(users))
  check('11 email identities created', ids === 11, String(ids))
  check('11 profiles rows created by the trigger', prof === 11, String(prof))

  const pw = (await db.query(`select left(encrypted_password,4) k,
      count(*) filter (where crypt('CalibiDemo@123', encrypted_password) = encrypted_password)::int ok
      from auth.users group by 1`)).rows
  check('passwords are bcrypt ($2a$/$2b$)', pw.length === 1 && /^\$2[aby]\$/.test(pw[0].k), JSON.stringify(pw))
  check('all 11 passwords verify with CalibiDemo@123', pw[0]?.ok === 11, JSON.stringify(pw))

  const pid = (await db.query(`select count(*)::int n from auth.identities where provider_id = 'email'`)).rows[0].n
  check("provider_id is per-user, not the literal 'email'", pid === 0, String(pid))

  const v = (await db.query(step(4))).rows
  check('STEP 4 reports every column true', v.length === 11 && v.every(r => r.auth_user_with_expected_id && r.can_sign_in_with_password && r.profile_row_exists && r.password_verifies), JSON.stringify(v[0]))

  console.log('\n=== C) idempotency: run STEP 2 + STEP 3 again ===')
  const r2b = await run(db, 'step2 again', step(2))
  const r3b = await run(db, 'step3 again', step(3))
  const users2 = (await db.query('select count(*)::int n from auth.users')).rows[0].n
  const ids2 = (await db.query('select count(*)::int n from auth.identities')).rows[0].n
  check('re-run does not error', r2b.ok && r3b.ok, `${r2b.msg} ${r3b.msg}`)
  check('no duplicate users/identities', users2 === 11 && ids2 === 11, `${users2}/${ids2}`)

  console.log('\n=== D) the FK error the sync hit is gone ===')
  const fk = await run(db, 'profiles upsert', `insert into public.profiles (id, email, full_name, phone, college)
    values ('df972f0a-cc01-53d6-b489-32369ef9695b','testuser@example.com','Test User','9822011111','PCCOE')
    on conflict (id) do update set phone = excluded.phone, college = excluded.college`)
  check('profiles upsert now passes the FK', fk.ok, fk.msg)
  const row = (await db.query(`select phone, college from public.profiles where id='df972f0a-cc01-53d6-b489-32369ef9695b'`)).rows[0]
  check('...and stored the data', row.phone === '9822011111' && row.college === 'PCCOE', JSON.stringify(row))
  const before = await run(db, 'fk proof', `insert into public.profiles (id,email) values ('99999999-9999-4999-8999-999999999999','ghost@example.com')`)
  check('a profiles row with no auth user still fails the FK (the original error)', !before.ok && /profiles_id_fkey/.test(before.msg), before.msg)
}

console.log(`\n=== E) older schema (auth.identities.id text) ===`)
{
  const db = await build('text')
  const a = await run(db, 's1', step(1)); const b = await run(db, 's2', step(2)); const c = await run(db, 's3', step(3))
  const ids = (await db.query('select count(*)::int n from auth.identities')).rows[0].n
  check('STEP 1/2/3 run on the text-id schema too', a.ok && b.ok && c.ok, `${a.msg} ${b.msg} ${c.msg}`)
  check('11 identities inserted', ids === 11, String(ids))
}

console.log(`\n=== F) why NULL instead of '' for the token columns ===`)
{
  const db = await build('uuid')
  const bad = await run(db, 'empty tokens', `insert into auth.users (id,email,confirmation_token) values
    (gen_random_uuid(),'a@example.com',''),(gen_random_uuid(),'b@example.com','')`)
  check("two rows with confirmation_token = '' collide on the unique index", !bad.ok && /duplicate key/.test(bad.msg), bad.msg)
  const good = await run(db, 'null tokens', `insert into auth.users (id,email,confirmation_token) values
    (gen_random_uuid(),'a@example.com',null),(gen_random_uuid(),'b@example.com',null)`)
  check('NULL is safe for any number of rows', good.ok, good.msg)
}

console.log('')
if (failures) { console.log(`✗ ${failures} check(s) failed`); process.exit(1) }
console.log('✓ all checks passed')
