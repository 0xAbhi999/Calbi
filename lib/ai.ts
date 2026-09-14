// Server-side AI evaluation layer (branded CalibiAI).
// Uses the CalibiAI grader when an API key is configured; otherwise falls back
// to a deterministic rule-based heuristic so the flow always works.
// Never imported by client components directly — go through /api/ai/evaluate.
//
// Grading philosophy (per product requirement): brutal and honest. Empty,
// trivial or off-task submissions score 0 — never a "participation" score. The
// guard clauses below run BEFORE the model so a blank answer can never be
// inflated by a lenient LLM.

import { fetchWithTimeout } from './fetchTimeout.ts'

export type AiKind = 'writing' | 'speaking' | 'debugging' | 'feature' | 'prompt'

export interface AiEval {
  score: number                 // 0..100
  rubric: Record<string, number> // criterion -> 0..100
  strengths: string[]
  improvements: string[]
  summary: string
  engine: 'calibiai' | 'heuristic'
}

const AI_KEY = process.env.CALIBIAI_API_KEY || process.env.DEEPSEEK_API_KEY || ''
const AI_BASE = process.env.CALIBIAI_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const AI_MODEL = process.env.CALIBIAI_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat'

// Hard ceiling on the upstream grader. A hung model must degrade to the local
// heuristic engine (callCalibiAi catches the abort and returns null) instead
// of holding the request handler open under load.
const AI_TIMEOUT_MS = 15000

// Prompt submissions must contain at least this many characters to earn any
// credit. Shorter answers are treated as empty and score 0 (with a clear note).
const MIN_PROMPT_CHARS = 100

export function isCalibiAiConfigured(): boolean {
  return !!AI_KEY
}

function clamp(n: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

function avg(nums: number[]) {
  return clamp(nums.reduce((a, b) => a + b, 0) / Math.max(1, nums.length))
}

// A zero-scored evaluation with an honest explanation.
function zero(improvements: string[], summary: string): AiEval {
  return {
    score: 0,
    rubric: {},
    strengths: [],
    improvements,
    summary,
    engine: 'heuristic',
  }
}

// ---------------------------------------------------------------------------
// CalibiAI grader call
// ---------------------------------------------------------------------------
async function callCalibiAi(systemPrompt: string, userPrompt: string): Promise<any | null> {
  if (!AI_KEY) return null
  try {
    const res = await fetchWithTimeout(`${AI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY}` },
      body: JSON.stringify({
        model: AI_MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    }, AI_TIMEOUT_MS)
    if (!res.ok) {
      console.error('CalibiAI grader error', res.status, await res.text().catch(() => ''))
      return null
    }
    const data = await res.json()
    const content: string = data?.choices?.[0]?.message?.content
    if (!content) return null
    return JSON.parse(content)
  } catch (e) {
    console.error('CalibiAI grader call failed', e)
    return null
  }
}

const JSON_CONTRACT = `Respond ONLY with a JSON object of exactly this shape:
{
  "score": <integer 0-100, overall>,
  "rubric": { "<criterion>": <integer 0-100>, ... },
  "strengths": ["<short bullet>", ...],
  "improvements": ["<short, actionable bullet>", ...],
  "summary": "<one sentence overall judgement>"
}
You are a strict, honest examiner. Do not inflate scores. Empty, trivial, off-task
or barely-attempted submissions MUST score 0-10. A submission that is merely
non-empty but does not satisfy the task should score well below 50. Be critical
and specific — never generic praise.`

// ---------------------------------------------------------------------------
// Per-kind evaluation
// ---------------------------------------------------------------------------
export async function evaluateWriting(text: string, scenario: string): Promise<AiEval> {
  const t = (text || '').trim()
  const words = t.split(/\s+/).filter(Boolean).length
  // Brutal guard: no meaningful answer => 0.
  if (words < 15) {
    return zero(['Write a substantive email — aim for 150–300 words covering impact, mitigation and a revised timeline.'], 'No meaningful answer submitted — scored 0.')
  }
  const sys = `You are an expert IELTS/Cambridge-certified English assessor for a graduate hiring assessment.
Evaluate the candidate's email against the scenario on four criteria, each 0-100:
clarity, grammar, structure, professional_tone. Also judge whether it addresses impact, mitigation and a revised timeline.
${JSON_CONTRACT}`
  const ai = await callCalibiAi(sys, `Scenario:\n${scenario}\n\nCandidate's email:\n"""\n${text}\n"""`)
  if (ai) return normalize(ai, 'calibiai', ['clarity', 'grammar', 'structure', 'professional_tone'])

  // heuristic fallback
  const clarity = words >= 150 && words <= 300 ? 82 : words >= 90 ? 70 : words >= 30 ? 52 : 25
  const grammar = t.length ? clamp(55 + Math.min(25, words / 10)) : 10
  const structure = /dear|hi|hello|regards|sincerely|thanks/i.test(t) ? 80 : t.length > 200 ? 66 : 45
  const tone = /please|thank|apolog|regret|understand|committed/i.test(t) ? 82 : 55
  return {
    score: avg([clarity, grammar, structure, tone]),
    rubric: { clarity, grammar, structure, professional_tone: tone },
    strengths: words >= 150 ? ['Meets the target length (150–300 words)'] : [],
    improvements: words < 150 ? ['Expand to 150–300 words covering impact, mitigation and timeline'] : ['Tighten tone and proofread for grammar'],
    summary: 'Rule-based evaluation (connect CalibiAI for full AI grading).',
    engine: 'heuristic',
  }
}

export async function evaluateSpeaking(transcript: string | null, recordingCount: number): Promise<AiEval> {
  // Brutal guard: no audio recorded => 0, regardless of anything else.
  if (!recordingCount && !(transcript || '').trim()) {
    return zero(['Record both speaking tasks (60–90s each) — your audio is what is graded.'], 'No audio submitted — scored 0.')
  }
  // If a real transcript is available (production Whisper pipeline), grade it
  // honestly with the model. Otherwise fall through to the evidence heuristic.
  const tr = (transcript || '').trim()
  if (tr) {
    const sys = `You are an IELTS speaking examiner grading a recorded spoken response for a hiring assessment.
Grade 0-100 on: fluency, pronunciation, confidence, grammar, task_achievement.
Be brutal and honest: short, rambling, off-topic or heavily accented/unclear answers score low.
${JSON_CONTRACT}`
    const ai = await callCalibiAi(sys, `Transcript of the candidate's spoken answer:\n"""\n${tr}\n"""`)
    if (ai) return normalize(ai, 'calibiai', ['fluency', 'pronunciation', 'confidence', 'grammar'])
  }
  // Evidence-only heuristic: at least one recording was made, but without a
  // transcript we cannot verify content, so keep it conservative and honest.
  const base = recordingCount >= 2 ? 62 : 45
  const rubric = {
    fluency: clamp(base + 2), pronunciation: clamp(base - 4),
    confidence: clamp(base), grammar: clamp(base - 3),
  }
  return {
    score: avg(Object.values(rubric)),
    rubric,
    strengths: recordingCount >= 2 ? ['Both speaking tasks recorded'] : ['One speaking task recorded'],
    improvements: ['Speak for the full 60–90 seconds', 'Structure answers: situation → action → result'],
    summary: 'Recording captured. In production Whisper transcribes it and CalibiAI grades the transcript (heuristic score shown).',
    engine: 'heuristic',
  }
}

export async function evaluateDebugging(taskId: string, buggy: string, prompt: string, fix: string): Promise<AiEval> {
  const f = (fix || '').trim()
  // Brutal guard: no fix submitted, or a trivial stub, => 0.
  if (f.length < 25) {
    return zero(['Paste your actual corrected code — a stub or placeholder earns nothing.'], 'No real fix submitted — scored 0.')
  }
  const sys = `You are a senior software engineer grading an "AI-assisted debugging" task in a hiring assessment.
The candidate was given buggy code and asked to fix it (they may use AI). Grade 0-100 on:
correctness (does the fix actually solve the bug), root_cause_understanding, edge_cases, code_quality, test_awareness.
Inspect the submitted code carefully; partial fixes get partial credit. A fix that merely re-types the buggy code scores 0.
${JSON_CONTRACT}`
  const ai = await callCalibiAi(sys, `Task id: ${taskId}\n\nBuggy code:\n"""\n${buggy}\n"""\n\nRequirement:\n${prompt}\n\nCandidate's fixed code:\n"""\n${fix}\n"""`)
  if (ai) return normalize(ai, 'calibiai', ['correctness', 'root_cause_understanding', 'edge_cases', 'code_quality', 'test_awareness'])

  const fl = f.toLowerCase()
  let correctness = 30
  if (taskId === 'AD1' && /page\s*-\s*1|page\s*-\s*size|max\(0/.test(fl) && /size\s*<=?\s*0|page\s*<\s*1|isinstance|int\(/.test(fl)) correctness = 88
  else if (taskId === 'AD1' && /page\s*-\s*1/.test(fl)) correctness = 70
  if (taskId === 'AD2' && /promise|inflight|in-flight|pending/.test(fl)) correctness = 85
  if (taskId === 'AD3' && /\[.*for.*in.*if.*active|not u\[|reversed|copy\(|\[:\]/.test(fl)) correctness = 84
  if (f.length < 25) correctness = 0
  const rubric = {
    correctness,
    root_cause_understanding: clamp(correctness - 6),
    edge_cases: clamp(correctness - 12 + (/(edge|invalid|negative|beyond|empty|retry|fail)/.test(fl) ? 10 : 0)),
    code_quality: clamp(55 + Math.min(30, f.length / 12)),
    test_awareness: /test|assert|pytest|console\.log/.test(fl) ? 72 : 48,
  }
  return {
    score: avg(Object.values(rubric)),
    rubric,
    strengths: correctness >= 70 ? ['Core bug appears fixed'] : correctness >= 40 ? ['Partial fix attempted'] : [],
    improvements: ['Add explicit handling for invalid inputs and boundary cases', 'Include tests proving the fix'],
    summary: 'Rule-based static heuristic (connect CalibiAI for semantic grading of the fix).',
    engine: 'heuristic',
  }
}

export async function evaluateFeature(spec: string, code: string): Promise<AiEval> {
  const c = (code || '').trim()
  // Brutal guard: no implementation => 0.
  if (c.length < 40) {
    return zero(['Implement the rate limiter (isAllowed) and wire the Express middleware — a stub earns nothing.'], 'No real implementation submitted — scored 0.')
  }
  const sys = `You are a staff engineer grading an "AI-assisted feature development" task in a hiring assessment.
Grade the candidate's implementation against the spec, 0-100 on:
requirement_understanding, functional_correctness, edge_cases, code_quality, api_integration (the Express middleware / 429 + Retry-After wiring).
Working, complete implementations score 75-95; stubs or partial logic score lower. Non-functional code scores near 0.
${JSON_CONTRACT}`
  const ai = await callCalibiAi(sys, `Spec:\n${spec}\n\nCandidate's implementation:\n"""\n${code}\n"""`)
  if (ai) return normalize(ai, 'calibiai', ['requirement_understanding', 'functional_correctness', 'edge_cases', 'code_quality', 'api_integration'])

  const cl = c.toLowerCase()
  let functional = /isallowed|is_allowed/.test(cl) ? 62 : 30
  if (/filter|timestamp|date\.now|performance\.now/.test(cl)) functional += 18
  if (/429|retry-after|retryafter|middleware/.test(cl)) functional += 12
  functional = clamp(functional)
  const rubric = {
    requirement_understanding: clamp(functional + 4),
    functional_correctness: functional,
    edge_cases: clamp(functional - 14 + (/clean|prune|shift|splice|delete/.test(cl) ? 8 : 0)),
    code_quality: clamp(50 + Math.min(35, c.length / 14)),
    api_integration: /429|retry-after|app\.(use|get|post)|middleware/.test(cl) ? 80 : 40,
  }
  return {
    score: avg(Object.values(rubric)),
    rubric,
    strengths: functional >= 75 ? ['Sliding-window logic and HTTP wiring present'] : functional >= 45 ? ['Attempts the limiter logic'] : [],
    improvements: ['Wire the 429 response with a Retry-After header in middleware', 'Add tests for window expiry and concurrent calls'],
    summary: 'Rule-based static heuristic (connect CalibiAI for semantic grading).',
    engine: 'heuristic',
  }
}

export async function evaluatePrompt(task: string, hint: string, prompt: string): Promise<AiEval> {
  const p = (prompt || '').trim()
  // Brutal guard: a prompt shorter than MIN_PROMPT_CHARS is effectively empty —
  // it earns 0 so the candidate must actually write a real prompt.
  if (p.length < MIN_PROMPT_CHARS) {
    return zero([`Write a real prompt — at least ${MIN_PROMPT_CHARS} characters — naming a role, giving context, constraints and an output format.`], `Prompt is below the ${MIN_PROMPT_CHARS}-character minimum — scored 0.`)
  }
  const sys = `You are an expert prompt engineer grading a "prompt engineering" hiring task.
Grade the candidate's prompt 0-100 on: role_definition, context, constraints, output_format, specificity, task_decomposition.
A strong prompt names a role, gives context/audience, states constraints, pins the output format, and prevents hallucination.
Be brutal: a vague or generic prompt that would produce poor output scores low.
${JSON_CONTRACT}`
  const ai = await callCalibiAi(sys, `Task:\n${task}\n\nHint: ${hint}\n\nCandidate's prompt:\n"""\n${prompt}\n"""`)
  if (ai) return normalize(ai, 'calibiai', ['role_definition', 'context', 'constraints', 'output_format', 'specificity', 'task_decomposition'])

  const pl = p.toLowerCase()
  const rubric = {
    role_definition: /act as|you are|role|as an? /.test(pl) ? 85 : 45,
    context: /audience|ceo|context|background|given|scenario/.test(pl) ? 78 : 50,
    constraints: /constraint|limit|must|only|without|no more than|under \d|memory/.test(pl) ? 80 : 45,
    output_format: /json|format|bullet|table|exactly \d|fields?|return/.test(pl) ? 82 : 40,
    specificity: p.length > 240 ? 82 : p.length > 180 ? 74 : p.length > 120 ? 60 : 45,
    task_decomposition: /step|first|then|finally|break down|numbered/.test(pl) ? 74 : 48,
  }
  return {
    score: avg(Object.values(rubric)),
    rubric,
    strengths: ['Prompt includes several effective elements'],
    improvements: ['Pin the exact output format (e.g. strict JSON)', 'Add explicit constraints and a hallucination guardrail'],
    summary: 'Rule-based rubric heuristic (connect CalibiAI for semantic grading).',
    engine: 'heuristic',
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function normalize(ai: any, engine: AiEval['engine'], criteria: string[]): AiEval {
  const rubric: Record<string, number> = {}
  criteria.forEach((c) => {
    rubric[c] = clamp(Number(ai?.rubric?.[c] ?? ai?.rubric?.[c.toLowerCase()] ?? 40))
  })
  const score = clamp(Number(ai?.score ?? avg(Object.values(rubric))))
  return {
    score,
    rubric,
    strengths: Array.isArray(ai?.strengths) ? ai.strengths.slice(0, 5).map(String) : [],
    improvements: Array.isArray(ai?.improvements) ? ai.improvements.slice(0, 5).map(String) : [],
    summary: String(ai?.summary || 'AI evaluation complete.'),
    engine,
  }
}
