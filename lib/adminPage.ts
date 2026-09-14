// Pure pagination / filter / sort helpers for the admin dashboard.
//
// This module has NO Node or Supabase imports (like studentRows.ts) so unit
// tests can load it directly. It holds every piece of pagination logic that
// must stay identical between the SQL query (remote store) and the in-memory
// path (local store + merge), plus the merge-window math that makes
// server-side pagination correct across the two stores.
//
// Why a "window" instead of plain OFFSET/LIMIT: the dashboard merges Supabase
// rows with rows from the local JSON store (seeded/demo candidates that were
// never written to Postgres). Local reads are free (no egress) but the merged
// global order interleaves both sets, so a naive SQL window would misplace
// rows around page boundaries. Instead the server over-fetches the remote
// window by the (small) local count, merges, sorts, and slices — see
// remoteWindowFor()/sliceMergedPage(). Proof of coverage is in the tests.
import type { AdminStudentRow } from './csv'

export const ADMIN_PAGE_SIZE_DEFAULT = 50
export const ADMIN_PAGE_SIZE_MAX = 200
export const ADMIN_QUERY_MAX_LENGTH = 100

export type AdminSortKey = 'score' | 'name'
export type AdminSortDir = 'asc' | 'desc'

export interface AdminPageParams {
  page: number
  pageSize: number
  /** '' means "all colleges". */
  college: string
  q: string
  sort: AdminSortKey
  dir: AdminSortDir
  assessed: boolean
}

/** Validate + clamp raw query params (never throws). */
export function parsePageParams(input: {
  page?: unknown
  pageSize?: unknown
  college?: unknown
  q?: unknown
  sort?: unknown
  dir?: unknown
  assessed?: unknown
}): AdminPageParams {
  const pageRaw = Number.parseInt(String(input.page ?? ''), 10)
  const sizeRaw = Number.parseInt(String(input.pageSize ?? ''), 10)
  const sort: AdminSortKey = input.sort === 'name' ? 'name' : 'score'
  const dir: AdminSortDir =
    input.dir === 'asc' ? 'asc' : input.dir === 'desc' ? 'desc' : sort === 'name' ? 'asc' : 'desc'
  return {
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1,
    pageSize:
      Number.isFinite(sizeRaw) && sizeRaw > 0
        ? Math.min(Math.floor(sizeRaw), ADMIN_PAGE_SIZE_MAX)
        : ADMIN_PAGE_SIZE_DEFAULT,
    college: String(input.college ?? '').trim().slice(0, ADMIN_QUERY_MAX_LENGTH),
    q: String(input.q ?? '').trim().slice(0, ADMIN_QUERY_MAX_LENGTH),
    sort,
    dir,
    assessed: input.assessed === '1' || input.assessed === 'true' || input.assessed === 'yes',
  }
}

// ---------------------------------------------------------------------------
// Search → PostgREST
// ---------------------------------------------------------------------------

/**
 * Sanitize free text for use INSIDE a PostgREST `or(...)` logic string, where
 * commas, parens, dots, quotes, colons and backslashes are STRUCTURAL and
 * would corrupt the query (or 500 it). Stripped chars simply narrow the
 * search slightly; dots become `_` (single-char LIKE wildcard), so searching
 * "aarti@x.com" still matches "aarti@x.com".
 *
 * NOTE: regular `.eq()/.ilike()/.in()` filters do NOT need this — supabase-js
 * URL-encodes those values, so commas/parens/dots in a college name are safe
 * there. Only the raw `or()` string needs sanitizing.
 */
export function sanitizeLikeFragment(value: string): string {
  return value.replace(/[,()*:'"\\]/g, '').replace(/\./g, '_')
}

const SEARCH_COLUMNS = ['full_name', 'email', 'prn', 'phone', 'college'] as const

/**
 * Build the `or()` body for the dashboard search box (name/email/PRN/mobile/
 * college substring, case-insensitive). Returns null when nothing searchable
 * remains after sanitizing — the caller must then apply a match-nothing
 * filter instead of dropping the search term.
 */
export function buildSearchOr(q: string): string | null {
  const clean = sanitizeLikeFragment(q).trim()
  if (!clean || !clean.replace(/_/g, '')) return null
  const like = `*${clean}*`
  return SEARCH_COLUMNS.map(c => `${c}.ilike.${like}`).join(',')
}

/** A student id that can never exist — used to force an empty result set. */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000'

// ---------------------------------------------------------------------------
// Ordering — MUST mirror the SQL ORDER BY or rows drift across page edges.
// ---------------------------------------------------------------------------

/**
 * Plain code-unit string comparison (NOT localeCompare): it matches Postgres'
 * default byte-wise collation closely, so the in-memory merge order agrees
 * with the SQL window order and page boundaries stay stable.
 */
export function compareText(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * Row comparator for the merged (remote + local) page. Semantics mirror the
 * SQL query: score '' sorts as -1 (first in asc, last in desc — like SQL
 * NULLS FIRST/LAST), then college ascending, then student_id ascending as a
 * final deterministic tiebreak.
 */
export function compareAdminRows(
  sort: AdminSortKey,
  dir: AdminSortDir,
): (a: AdminStudentRow, b: AdminStudentRow) => number {
  const d = dir === 'desc' ? -1 : 1
  return (a, b) => {
    if (sort === 'score') {
      const av = a.score === '' ? -1 : Number(a.score)
      const bv = b.score === '' ? -1 : Number(b.score)
      if (av !== bv) return (av - bv) * d
    } else {
      const c = compareText(a.name || '', b.name || '')
      if (c !== 0) return c * d
    }
    const cc = compareText(a.college || '', b.college || '')
    if (cc !== 0) return cc
    return compareText(a.student_id || '', b.student_id || '')
  }
}

// ---------------------------------------------------------------------------
// In-memory filtering (local store + full-fetch fallback path)
// ---------------------------------------------------------------------------

/** Same predicate the SQL WHERE clause implements (modulo the assessed edge — see below). */
export function filterAdminRows(
  rows: AdminStudentRow[],
  opts: { college?: string; q?: string; assessed?: boolean },
): AdminStudentRow[] {
  const college = String(opts.college || '').trim().toLowerCase()
  const needle = String(opts.q || '').trim().toLowerCase()
  const assessed = !!opts.assessed
  return rows.filter(r => {
    if (college && college !== 'all' && r.college.trim().toLowerCase() !== college) return false
    if (needle) {
      const hay = [r.name, r.email, r.prn, r.phone, r.college].join(' ').toLowerCase()
      if (!hay.includes(needle)) return false
    }
    if (assessed && r.has_assessment !== 'Yes') return false
    return true
  })
}

// ---------------------------------------------------------------------------
// Merge-window math
// ---------------------------------------------------------------------------

/**
 * Remote (SQL) window covering global page `page` when `localCount` local rows
 * interleave in the sort order. A remote row at remote-index `i` sits at a
 * global position in [i, i+L], so global [P, P+S) needs remote [P-L, P+S) —
 * fetched as offset=max(0,P-L), limit=S+2L (the extra L covers the max(0,·)
 * clamp on early pages). When L=0 this collapses to plain OFFSET/LIMIT.
 */
export function remoteWindowFor(
  page: number,
  pageSize: number,
  localCount: number,
): { offset: number; limit: number } {
  const P = (page - 1) * pageSize
  const L = Math.max(0, Math.floor(localCount))
  if (L === 0) return { offset: P, limit: pageSize }
  return { offset: Math.max(0, P - L), limit: pageSize + 2 * L }
}

/**
 * Slice one global page out of the merged (remote window + ALL local rows)
 * list after sorting it with compareAdminRows(). `remoteOffset` is the offset
 * the remote window was fetched with.
 */
export function sliceMergedPage<T>(
  mergedSorted: T[],
  page: number,
  pageSize: number,
  remoteOffset: number,
): T[] {
  const start = Math.max(0, (page - 1) * pageSize - remoteOffset)
  return mergedSorted.slice(start, start + pageSize)
}
