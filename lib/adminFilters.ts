// Shared server-side row filtering for the admin CSV export.
// `college` matches exactly (case-insensitive); `q` searches name / email /
// prn / phone / college substrings; `assessed` keeps rows with a completed
// assessment. Passing an empty string keeps everything.
// (The on-screen table is filtered in SQL by fetchStudentsPage; this stays in
// sync with filterAdminRows in lib/adminPage.ts for the same predicate.)
export function filterRows<T extends { college: string; name: string; email: string; prn: string; phone: string; has_assessment?: string }>(
  rows: T[],
  opts: { college?: string; q?: string; assessed?: boolean } = {},
): T[] {
  const college = String(opts.college || '').trim().toLowerCase()
  const q = String(opts.q || '').trim().toLowerCase()
  return rows.filter(r => {
    if (college && r.college.trim().toLowerCase() !== college) return false
    if (q) {
      const hay = [r.name, r.email, r.prn, r.phone, r.college].join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    if (opts.assessed && r.has_assessment !== 'Yes') return false
    return true
  })
}
