// Admin CSV utilities — pure functions + the shared row type. This module has
// NO Node/server imports so it is safe to use from both API routes (server)
// and the admin dashboard page (browser bundle). The dashboard generates the
// CSV from the rows it already fetched, so a download always matches the
// filters on screen exactly.

export interface AdminFeedbackEntry {
  id: string
  student_id: string
  email: string
  rating: string
  message: string
  session_id: string
  source: string
  created_at: string
}

export interface AdminStudentRow {
  student_id: string
  email: string
  name: string
  role: string
  // Profile
  prn: string
  phone: string
  dob: string
  gender: string
  degree: string
  college: string
  graduation_year: string
  cgpa: string
  skills: string
  resume_skills: string
  all_skills: string
  linkedin_url: string
  github_url: string
  created_at: string
  // Resume
  resume_score: string
  // Assessment
  has_assessment: string
  score: string
  grade: string
  percentile: string
  english: string
  english_listening: string
  english_speaking: string
  english_reading: string
  english_writing: string
  problem_solving: string
  ai_debugging: string
  ai_feature: string
  prompt_engineering: string
  cognitive: string
  cognitive_grid: string
  cognitive_logical: string
  behavioral_total: string
  teamwork: string
  accountability: string
  adaptability: string
  responsible_ai: string
  decision_making: string
  learning_mindset: string
  listening_correct: string
  listening_total: string
  reading_correct: string
  reading_total: string
  problem_correct: string
  problem_total: string
  logical_correct: string
  logical_total: string
  verifiable_hash: string
  assessed_at: string
  // Feedback the candidate gave about the assessment (latest submission)
  feedback_rating: string
  feedback_message: string
  feedback_at: string
  feedback_count: string
  /** Every submission, newest first; the table fields above are the latest one. */
  feedback_history?: AdminFeedbackEntry[]
}

export const CSV_COLUMNS: { key: keyof AdminStudentRow; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'prn', label: 'PRN' },
  { key: 'phone', label: 'Mobile Number' },
  { key: 'dob', label: 'Date of Birth' },
  { key: 'gender', label: 'Gender' },
  { key: 'degree', label: 'Degree' },
  { key: 'college', label: 'College' },
  { key: 'graduation_year', label: 'Graduation Year' },
  { key: 'cgpa', label: 'CGPA' },
  { key: 'skills', label: 'Profile Skills' },
  { key: 'resume_skills', label: 'Resume Skills' },
  { key: 'all_skills', label: 'All Skills' },
  { key: 'linkedin_url', label: 'LinkedIn URL' },
  { key: 'github_url', label: 'GitHub URL' },
  { key: 'resume_score', label: 'Resume Score (/100)' },
  { key: 'score', label: 'CalibiAI Score (/1000)' },
  { key: 'grade', label: 'Grade' },
  { key: 'percentile', label: 'Percentile' },
  { key: 'english', label: 'English (/200)' },
  { key: 'english_listening', label: 'English - Listening (/50)' },
  { key: 'english_speaking', label: 'English - Speaking (/50)' },
  { key: 'english_reading', label: 'English - Reading (/50)' },
  { key: 'english_writing', label: 'English - Writing (/50)' },
  { key: 'problem_solving', label: 'Problem Solving (/200)' },
  { key: 'ai_debugging', label: 'AI Debugging (/150)' },
  { key: 'ai_feature', label: 'AI Feature Dev (/150)' },
  { key: 'prompt_engineering', label: 'Prompt Engineering (/100)' },
  { key: 'cognitive', label: 'Cognitive (/200)' },
  { key: 'cognitive_grid', label: 'Cognitive - Grid (/30)' },
  { key: 'cognitive_logical', label: 'Cognitive - Logical (/70)' },
  { key: 'behavioral_total', label: 'Behavioural (/100)' },
  { key: 'teamwork', label: 'Trait - Teamwork' },
  { key: 'accountability', label: 'Trait - Accountability' },
  { key: 'adaptability', label: 'Trait - Adaptability' },
  { key: 'responsible_ai', label: 'Trait - Responsible AI' },
  { key: 'decision_making', label: 'Trait - Decision Making' },
  { key: 'learning_mindset', label: 'Trait - Learning Mindset' },
  { key: 'listening_correct', label: 'Listening Correct' },
  { key: 'listening_total', label: 'Listening Total' },
  { key: 'reading_correct', label: 'Reading Correct' },
  { key: 'reading_total', label: 'Reading Total' },
  { key: 'problem_correct', label: 'Problem Solving Correct' },
  { key: 'problem_total', label: 'Problem Solving Total' },
  { key: 'logical_correct', label: 'Logical Correct' },
  { key: 'logical_total', label: 'Logical Total' },
  { key: 'feedback_rating', label: 'Feedback Rating (1-5)' },
  { key: 'feedback_message', label: 'Feedback Comment' },
  { key: 'feedback_at', label: 'Feedback Date' },
  { key: 'feedback_count', label: 'Feedback Submissions' },
  { key: 'verifiable_hash', label: 'Verifiable Hash' },
  { key: 'assessed_at', label: 'Assessment Date' },
]

function escapeCell(value: string): string {
  let v = String(value ?? '')
  // Guard against CSV injection (=, +, -, @ at the start of a cell).
  if (/^[=+\-@]/.test(v)) v = `'${v}`
  if (/[",\n\r]/.test(v)) v = `"${v.replace(/"/g, '""')}"`
  return v
}

export function rowsToCsv(rows: AdminStudentRow[]): string {
  const header = CSV_COLUMNS.map(c => escapeCell(c.label)).join(',')
  const body = rows.map(r => CSV_COLUMNS.map(c => escapeCell(String((r as any)[c.key] ?? ''))).join(','))
  // BOM so Excel opens UTF-8 (✓, names, etc.) correctly; CRLF per RFC 4180.
  return '\uFEFF' + [header, ...body].join('\r\n')
}

export function downloadFilename(scope: string): string {
  const date = new Date().toISOString().slice(0, 10)
  return `calibiai_students_${scope}_${date}.csv`
}

/** Trigger a browser download from a CSV string (client-side). */
export function downloadCsv(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
