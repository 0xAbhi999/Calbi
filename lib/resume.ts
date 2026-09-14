// Server-side resume analysis.
// Uses the CalibiAI resume grader when an API key is set; otherwise a
// deterministic rule-based engine so the flow always works. Text is extracted
// from the uploaded PDF/DOCX/TXT first so both engines analyse the REAL
// document — which is what enables name-mismatch, recruiter flags, and
// professionalism checks.

import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import { fetchWithTimeout } from './fetchTimeout.ts'

export const MAX_RESUME_BYTES = 5 * 1024 * 1024

export interface ResumeFlag {
  level: 'error' | 'warn' | 'ok'
  text: string
}

export interface ResumeAnalysis {
  resume_score: number
  engine: 'calibiai' | 'heuristic'
  name_match: boolean
  detected_name: string
  flags: ResumeFlag[]
  professionalism: number
  summary: string
  experience: { years: number; entries: string[] }
  education: string[]
  skills: string[]
  contact: { email?: string; phone?: string; linkedin?: string; github?: string }
  feedback: { strengths: string[]; gaps: string[]; suggestions: string[] }
  parsed: { name: string; experience_years: number; projects: number; skills: string[] }
  word_count: number
}

export interface CandidateContext {
  full_name?: string
  email?: string
  degree?: string
  skills?: string
}

export function isCalibiAiConfigured(): boolean {
  return !!(process.env.CALIBIAI_API_KEY || process.env.DEEPSEEK_API_KEY)
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------
export async function extractResumeText(buffer: Buffer, filename: string): Promise<string> {
  const name = filename.toLowerCase()
  if (name.endsWith('.pdf')) {
    const parser = new PDFParse({ data: new Uint8Array(buffer) })
    try {
      const result = await parser.getText()
      return ((result as any).pages || []).map((pg: any) => pg.text || '').join('\n').trim()
    } finally {
      await parser.destroy().catch(() => {})
    }
  }
  if (name.endsWith('.docx')) {
    const res = await mammoth.extractRawText({ buffer })
    return (res.value || '').trim()
  }
  if (name.endsWith('.txt') || name.endsWith('.md')) {
    return buffer.toString('utf8').trim()
  }
  throw new Error('Unsupported file type — upload a PDF, DOCX or TXT resume.')
}

// ---------------------------------------------------------------------------
// CalibiAI Integration — Brutal & Honest Technical Recruiter Evaluation
// ---------------------------------------------------------------------------
const AI_BASE = process.env.CALIBIAI_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const AI_MODEL = process.env.CALIBIAI_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat'

const BRUTAL_RECRUITER_CONTRACT = `Respond ONLY with a valid JSON object matching exactly this schema:
{
  "resume_score": <integer 0-100, brutal ATS/recruiter overall rating>,
  "professionalism": <integer 0-100, formatting, tone, structure, typography rating>,
  "name_match": <boolean: true if resume belongs to candidate full_name in context, false otherwise>,
  "detected_name": "<name found at the top of the resume, or '' if none>",
  "flags": [
    {"level": "error"|"warn"|"ok", "text": "<direct, candid recruiter feedback flag>"}
  ],
  "summary": "<3-5 sentence brutally honest executive summary of candidate readiness and resume strength>",
  "experience": {"years": <number>, "entries": ["<role — company — period>", ...]},
  "education": ["<degree — institution>", ...],
  "skills": ["<hard technical skill>", ...],
  "contact": {"email": "", "phone": "", "linkedin": "", "github": ""},
  "strengths": ["<clear, earned strength bullet>", ...],
  "gaps": ["<critical, uncompromising gap or missing element bullet>", ...],
  "suggestions": ["<sharp, highly actionable improvement instruction>", ...]
}

EVALUATION PHILOSOPHY (BRUTAL, UNCOMPROMISING & HONEST):
You are a senior hiring bar-raiser and Lead Technical Recruiter at a top-tier tech firm (FAANG/Tier-1).
Your job is to provide honest, unfiltered, and constructive critique. DO NOT inflate scores. DO NOT give courtesy points.

Scoring Calibration Scale:
- 0-35 (Failing / Unacceptable): Name mismatch, stub/empty (<100 words), generic template text, missing contact info, unreadable format, or no projects.
- 36-50 (Weak / High Rejection Risk): Has basic sections, but zero quantified metrics (e.g., 'worked on web app'), passive voice, missing GitHub/live links, generic fluff.
- 51-65 (Below Average / Candidate Backlog): Lists tech stack and projects, but bullet points are task lists rather than measurable engineering impact.
- 66-78 (Average / Standard Graduate): Decent structure, some metrics, readable, but lacks standout technical complexity, architectural depth, or verifiable proof of work.
- 79-88 (Strong / Competitive): Consistent quantifiable achievements (e.g., 'reduced API response latency by 35%', 'handled 50k+ daily queries'), strong GitHub/demos, clean ATS formatting.
- 89-100 (Exceptional / Top 2% Bar-Raiser): Outstanding open-source, production deployments, extraordinary quantified impact across every single bullet.

Strict Rules:
1. If the resume has ZERO numbers, percentages, or measurable engineering outcomes, the score MUST NOT exceed 55.
2. If the resume is missing GitHub or live project URLs for developer roles, flag it as a warning and list it as a gap.
3. If the detected name on the resume differs from candidate full_name, set "name_match": false, flag with level "error", and cap score below 30.
4. Highlight vague buzzwords ('hardworking', 'enthusiastic', 'responsible for') as gaps.
5. Provide actionable suggestions that tell the candidate exactly how to rewrite bullet points using the Google XYZ formula: 'Accomplished [X] as measured by [Y], by doing [Z]'.`

async function callCalibiAi(text: string, ctx: CandidateContext): Promise<any | null> {
  const key = process.env.CALIBIAI_API_KEY || process.env.DEEPSEEK_API_KEY
  if (!key) return null
  try {
    const res = await fetchWithTimeout(`${AI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: AI_MODEL,
        temperature: 0.15,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: BRUTAL_RECRUITER_CONTRACT },
          {
            role: 'user',
            content: `Candidate context from application profile:\n${JSON.stringify(ctx, null, 2)}\n\nActual Resume Text extracted from document:\n"""\n${text.slice(0, 10000)}\n"""`,
          },
        ],
      }),
    }, 20000)
    if (!res.ok) {
      console.error('CalibiAI resume error:', res.status, await res.text().catch(() => ''))
      return null
    }
    const data = await res.json()
    const content: string = data?.choices?.[0]?.message?.content
    return content ? JSON.parse(content) : null
  } catch (e) {
    console.error('CalibiAI resume call failed:', e)
    return null
  }
}

// ---------------------------------------------------------------------------
// Heuristic Fallback Engine (Strict & Calibrated)
// ---------------------------------------------------------------------------
function clamp(n: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

const SKILL_KEYWORDS = [
  'python', 'java', 'javascript', 'typescript', 'react', 'node', 'node.js', 'express',
  'sql', 'mysql', 'postgres', 'mongodb', 'docker', 'kubernetes', 'aws', 'git', 'github',
  'html', 'css', 'tailwind', 'next.js', 'nextjs', 'c++', 'c#', 'django', 'flask', 'spring',
  'machine learning', 'deep learning', 'data structures', 'algorithms', 'linux', 'excel',
  'figma', 'power bi', 'tableau', 'tensorflow', 'pandas', 'numpy', 'rest api', 'graphql',
]

const ACTION_VERBS = [
  'led', 'built', 'developed', 'designed', 'implemented', 'improved', 'created', 'launched',
  'optimized', 'optimised', 'automated', 'delivered', 'managed', 'reduced', 'increased',
  'achieved', 'scaled', 'migrated', 'deployed', 'trained',
]

function detectName(text: string): string {
  const labeled = text.match(/^(?:candidate\s+)?name\s*[:\-]\s*([A-Za-z][A-Za-z .'-]{2,40})/im)
  if (labeled) return labeled[1].trim()
  const firstLine = text.split(/\r?\n/).map((l) => l.trim()).find((l) =>
    l.length > 2 && l.length <= 48 &&
    !/[@\d]/.test(l) &&
    !/resume|curriculum|vitae|objective|summary|contact/i.test(l) &&
    /^[A-Z][a-zA-Z.'-]*(\s+[A-Z][a-zA-Z.'-]*){1,3}$/.test(l)
  )
  return firstLine || ''
}

export async function analyzeResumeText(rawText: string, ctx: CandidateContext): Promise<ResumeAnalysis> {
  const text = rawText.replace(/\s+\n/g, '\n')
  const lower = text.toLowerCase()
  const words = (text.match(/\S+/g) || []).length

  // Prioritize CalibiAI analysis
  const ai = await callCalibiAi(text, ctx)
  if (ai) return normalizeAi(ai, text, words)

  // ---------------- Strict Heuristic Fallback Engine ----------------
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0]
  const phone = text.match(/(\+?\d[\d\s()-]{8,14}\d)/)?.[0]?.trim()
  const linkedin = text.match(/linkedin\.com\/(?:in|pub)\/[\w-]+/i)?.[0]
  const github = text.match(/github\.com\/[\w-]+/i)?.[0]

  const hasSection = (re: RegExp) => re.test(lower)
  const sections = {
    experience: hasSection(/experience|internship|employment|work history/),
    education: hasSection(/education|academics|university|college/),
    skills: hasSection(/skills|technologies|tech stack|proficiencies/),
    projects: hasSection(/projects|technical projects|portfolio/),
  }

  const detected = detectName(text)
  const nameTokens = (ctx.full_name || '').toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 3)
  const matchedTokens = nameTokens.filter((t) => lower.includes(t))
  const name_match = nameTokens.length === 0 ? true : matchedTokens.length >= Math.max(1, Math.ceil(nameTokens.length / 2))

  const metrics = (text.match(/\d+(\.\d+)?\s*(%|percent|\bx\b|users|customers|ms|seconds?|minutes?|latency|revenue|requests|₹|\$|k\b|queries|qps)/gi) || []).length
  const verbs = ACTION_VERBS.filter((v) => new RegExp(`\\b${v}\\b`, 'i').test(text)).length
  const skills = SKILL_KEYWORDS.filter((s) => lower.includes(s))
  const slang = (text.match(/\b(u|ur|plz|thx|wanna|gonna|kinda|lol|omg|stuff like that|hardworking|enthusiastic|team player)\b/gi) || []).length
  const years = Array.from(new Set((text.match(/20\d{2}/g) || []).map(Number))).sort((a, b) => a - b)
  const expSpan = years.length >= 2 ? Math.min(10, Math.max(0, years[years.length - 1] - years[0])) : 0
  const projects = (text.match(/\bprojects?\b/gi) || []).length

  const flags: ResumeFlag[] = []

  if (nameTokens.length > 0 && !name_match) {
    flags.push({
      level: 'error',
      text: `⛔ Name mismatch: Resume appears to belong to “${detected || 'someone else'}”, but your application profile states “${ctx.full_name}”. Upload your authentic resume.`,
    })
  } else {
    flags.push({
      level: 'ok',
      text: nameTokens.length ? `Candidate identity verified: Name matches profile (${ctx.full_name}).` : 'Name verified.',
    })
  }

  if (!email || !phone) {
    flags.push({ level: 'error', text: 'Missing essential contact details (Email or Phone) — ATS will discard this document.' })
  }
  if (!github && !linkedin) {
    flags.push({ level: 'warn', text: 'No GitHub or LinkedIn profiles linked — technical recruiters cannot verify your code or history.' })
  }
  if (!sections.projects && !sections.experience) {
    flags.push({ level: 'error', text: 'No Experience or Projects section found — high risk of immediate rejection.' })
  }
  if (metrics === 0) {
    flags.push({ level: 'error', text: '❌ Zero quantified metrics detected. Bullets only state generic duties rather than measurable engineering impact.' })
  } else if (metrics < 3) {
    flags.push({ level: 'warn', text: `Only ${metrics} quantified metric(s) found. Top resumes quantify impact across every single bullet.` })
  }
  if (words < 100) {
    flags.push({ level: 'error', text: `Resume is severely underdeveloped (${words} words) — insufficient content for technical screening.` })
  } else if (words > 1200) {
    flags.push({ level: 'warn', text: `Resume is too verbose (${words} words) — strictly prune down to 1-2 pages.` })
  }

  // Strict honest scoring calculation
  let baseScore = 30
  if (name_match) baseScore += 15
  if (email && phone) baseScore += 10
  if (sections.projects) baseScore += 12
  if (sections.experience) baseScore += 12
  if (sections.skills && skills.length >= 4) baseScore += 10
  if (github || linkedin) baseScore += 6

  // Impact factor (heavily penalizes lack of metrics)
  const impactScore = metrics === 0 ? 0 : Math.min(20, metrics * 5)
  const verbsScore = Math.min(10, verbs * 2)

  let totalScore = baseScore + impactScore + verbsScore
  if (words < 40 || !name_match) totalScore = Math.min(25, totalScore)
  else if (words < 80) totalScore = Math.min(50, totalScore)
  if (metrics === 0) totalScore = Math.min(54, totalScore) // Cap at 54 if zero metrics
  if (slang > 2) totalScore = Math.max(10, totalScore - 15)

  const resume_score = clamp(totalScore)
  const professionalism = clamp(
    85 - slang * 10 - (words < 40 ? 40 : words < 80 ? 20 : 0) - (metrics === 0 ? 15 : 0) + (email && phone ? 10 : 0) + (github ? 5 : 0),
  )

  const strengths: string[] = []
  if (metrics >= 3) strengths.push(`Quantified outcomes with ${metrics} measurable engineering metric(s)`)
  if (skills.length >= 6) strengths.push(`Solid technical keywords (${skills.slice(0, 5).join(', ')})`)
  if (github) strengths.push('Included GitHub profile for code verification')
  if (sections.projects && sections.experience) strengths.push('Structured with both Projects and Experience sections')
  if (strengths.length === 0) strengths.push('Document contains readable plain text')

  const gaps: string[] = []
  if (!name_match) gaps.push('Critical identity discrepancy with profile name')
  if (metrics === 0) gaps.push('Zero quantified metrics — bullets fail to show scale, latency, or business results')
  if (!github) gaps.push('No GitHub link to prove real code competence')
  if (!sections.projects) gaps.push('Missing portfolio/projects section for a junior/student developer')
  if (verbs < 4) gaps.push('Weak action verbs — avoid passive phrasing like "responsible for" or "helped with"')

  const suggestions: string[] = []
  if (!name_match) suggestions.push('Upload your own authentic resume matching your profile details.')
  suggestions.push('Rewrite every bullet point using Google’s XYZ formula: "Accomplished [X], as measured by [Y], by doing [Z]".')
  if (metrics === 0) suggestions.push('Add specific numbers (e.g. "% reduction in latency", "X daily users", "Y ms query optimization").')
  if (!github) suggestions.push('Add your GitHub profile with pinned repositories demonstrating clean commits and test suites.')
  suggestions.push('Eliminate generic buzzwords and focus strictly on architecture, libraries, and measurable results.')

  const summary =
    `${detected || 'The candidate'} presents a ${words}-word resume. ` +
    (name_match ? '' : `CRITICAL WARNING: The name on this resume does NOT match profile name "${ctx.full_name}". `) +
    (metrics === 0
      ? 'Honest Recruiter Assessment: Lacks any quantified metrics or measurable technical impact, resulting in a low ATS score. '
      : `Includes ${metrics} quantified metrics demonstrating engineering impact. `) +
    (github ? 'Includes code links. ' : 'Missing code/GitHub repository links for verification.')

  return {
    resume_score,
    engine: 'heuristic',
    name_match,
    detected_name: detected,
    flags,
    professionalism,
    summary,
    experience: { years: expSpan, entries: text.match(/.{0,60}20\d{2}\s*[-–—to]+\s*(20\d{2}|present|current).{0,20}/gi)?.slice(0, 6) || [] },
    education: (ctx.degree ? [ctx.degree] : []).concat(text.match(/(?<![\w./])(?:B\.?Tech|M\.?Tech|B\.?Sc|M\.?Sc|B\.?Com|M\.?B\.?A|B\.?C\.?A|M\.?C\.?A)[^\n]{0,40}/gi)?.slice(0, 3) || []),
    skills,
    contact: { email, phone, linkedin, github },
    feedback: { strengths: strengths.slice(0, 5), gaps: gaps.slice(0, 5), suggestions: suggestions.slice(0, 5) },
    parsed: { name: detected || ctx.full_name || 'Candidate', experience_years: expSpan, projects, skills: skills.slice(0, 8) },
    word_count: words,
  }
}

function normalizeAi(ai: any, text: string, words: number): ResumeAnalysis {
  const flags: ResumeFlag[] = Array.isArray(ai?.flags)
    ? ai.flags.slice(0, 8).map((f: any) => ({
        level: f?.level === 'error' ? 'error' : f?.level === 'ok' ? 'ok' : 'warn',
        text: String(f?.text || ''),
      }))
    : []
  const skills = Array.isArray(ai?.skills) ? ai.skills.slice(0, 12).map(String) : []
  const exp = ai?.experience || {}
  return {
    resume_score: clamp(Number(ai?.resume_score ?? 45)),
    engine: 'calibiai',
    name_match: ai?.name_match !== false,
    detected_name: String(ai?.detected_name || detectName(text)),
    flags,
    professionalism: clamp(Number(ai?.professionalism ?? 55)),
    summary: String(ai?.summary || 'Brutally honest AI analysis complete.'),
    experience: { years: Number(exp?.years ?? 0), entries: Array.isArray(exp?.entries) ? exp.entries.slice(0, 6).map(String) : [] },
    education: Array.isArray(ai?.education) ? ai.education.slice(0, 4).map(String) : [],
    skills,
    contact: {
      email: ai?.contact?.email || undefined,
      phone: ai?.contact?.phone || undefined,
      linkedin: ai?.contact?.linkedin || undefined,
      github: ai?.contact?.github || undefined,
    },
    feedback: {
      strengths: Array.isArray(ai?.strengths) ? ai.strengths.slice(0, 5).map(String) : [],
      gaps: Array.isArray(ai?.gaps) ? ai.gaps.slice(0, 5).map(String) : [],
      suggestions: Array.isArray(ai?.suggestions) ? ai.suggestions.slice(0, 5).map(String) : [],
    },
    parsed: {
      name: String(ai?.detected_name || 'Candidate'),
      experience_years: Number(exp?.years ?? 0),
      projects: (text.match(/\bprojects?\b/gi) || []).length,
      skills: skills.slice(0, 8),
    },
    word_count: words,
  }
}
