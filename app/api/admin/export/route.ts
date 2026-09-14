import { NextResponse } from 'next/server'
import { isAdminRequest } from '@/lib/adminAuth'
import { fetchAllStudents } from '@/lib/adminStudents'
import { filterRows } from '@/lib/adminFilters'
import { downloadFilename, rowsToCsv } from '@/lib/csv'

/**
 * GET /api/admin/export?college=&q=&assessed=1&scope=all|filtered
 * Downloads every student's full row as CSV (same columns as the dashboard
 * table). `scope=all` ignores the college/search/assessed filters so an admin
 * can always grab the complete dataset in one click. Always freshly computed
 * (never cached) so an explicit export matches the live data.
 */
export async function GET(req: Request) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const url = new URL(req.url)
    const scope = url.searchParams.get('scope') || 'filtered'
    const college = url.searchParams.get('college') || ''
    const q = url.searchParams.get('q') || ''
    const assessed = url.searchParams.get('assessed') === '1'
    const { students: all } = await fetchAllStudents()
    const rows = scope === 'all' ? all : filterRows(all, { college, q, assessed })
    const csv = rowsToCsv(rows)
    const file = scope === 'all' ? downloadFilename('all') : downloadFilename('filtered')
    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Export failed.' }, { status: 500 })
  }
}
