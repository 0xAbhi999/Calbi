// CalibiAI In-Exam Coding Assistant layer.
// Provides conversational guidance, explanations, debugging help, edge-case analysis,
// and code reviews for Stage 3 (AI-Assisted Debugging) and Stage 4 (AI Feature Dev).
//
// When an API key is configured, uses the CalibiAI coding assistant.
// Otherwise, uses a rich contextual heuristic knowledge engine tailored to AD1, AD2, AD3, and AF1.

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface AssistantRequest {
  taskId: string
  taskTitle?: string
  taskPrompt?: string
  buggyOrSpec?: string
  currentCode?: string
  messages: ChatMessage[]
}

export interface AssistantResponse {
  reply: string
  engine: 'calibiai' | 'heuristic'
  suggestions?: string[]
}

import { fetchWithTimeout } from './fetchTimeout.ts'

const AI_KEY = process.env.CALIBIAI_API_KEY || process.env.DEEPSEEK_API_KEY || ''
const AI_BASE = process.env.CALIBIAI_BASE_URL || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const AI_MODEL = process.env.CALIBIAI_MODEL || process.env.DEEPSEEK_MODEL || 'deepseek-chat'
// A hung assistant model must fall back to the heuristic engine, not hang the
// exam under load.
const AI_TIMEOUT_MS = 20000

export function isCalibiAiConfigured(): boolean {
  return !!AI_KEY
}

async function callCalibiAiChat(
  systemPrompt: string,
  messages: ChatMessage[],
): Promise<string | null> {
  if (!AI_KEY) return null
  try {
    const formattedMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
    ]

    const res = await fetchWithTimeout(`${AI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY}` },
      body: JSON.stringify({
        model: AI_MODEL,
        temperature: 0.3,
        messages: formattedMessages,
      }),
    }, AI_TIMEOUT_MS)

    if (!res.ok) {
      console.error('CalibiAI assistant error:', res.status, await res.text().catch(() => ''))
      return null
    }

    const data = await res.json()
    const reply: string = data?.choices?.[0]?.message?.content
    return reply || null
  } catch (err) {
    console.error('CalibiAI assistant call failed:', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Contextual Heuristic Knowledge Engine for In-Exam Coding Tasks
// ---------------------------------------------------------------------------

function getTaskKnowledge(taskId: string) {
  switch (taskId) {
    case 'AD1':
      return {
        name: 'Python — Off-by-one in pagination',
        language: 'python',
        rootCause:
          'In Python, list indexing and slicing are 0-based (`items[0:5]` returns elements 0 through 4). In human pagination, `page=1` is the first page. The original formula `start = page * size` with `page=1, size=5` calculates `start = 5`, which skips the first 5 elements (`[0..4]`) and wrongly returns `[5..9]`.',
        fixSummary: 'Calculate the start index using `start = (page - 1) * size` and `end = start + size`.',
        edgeCases: [
          '**`page < 1`** (e.g., `page=0` or negative): should return an empty list `[]` or handle gracefully without throwing.',
          '**`size <= 0`**: invalid page size, should return `[]`.',
          '**`start >= len(items)`** (requested page beyond the last page): should return an empty list `[]`.',
          '**`items` not a list or empty**: should return `[]`.',
        ],
        codeSnippet: `def paginate(items, page, size):
    # Validate inputs
    if not isinstance(items, (list, tuple)) or page < 1 or size <= 0:
        return []
    
    # 0-indexed slice calculation
    start = (page - 1) * size
    end = start + size
    
    # Check if start is beyond list bounds
    if start >= len(items):
        return []
        
    return list(items[start:end])`,
        suggestions: [
          '💡 Explain the off-by-one root cause',
          '🔍 What edge cases are tested for AD1?',
          '🛠️ Show me the corrected Python function',
          '📋 Review my current code',
        ],
      }

    case 'AD2':
      return {
        name: 'JavaScript — Race condition / duplicate fetches',
        language: 'javascript',
        rootCause:
          'When multiple asynchronous callers invoke `get(key, fetcher)` concurrently before the initial `fetcher()` resolves, `cache[key]` is still `undefined`. Thus, every caller executes `await fetcher()`, triggering multiple redundant network/DB calls. Furthermore, if `fetcher()` rejects, an uncaught error or broken state must be cleaned up so retries can succeed.',
        fixSummary:
          'Cache the in-flight `Promise` itself immediately when the request starts, rather than waiting for the resolved value. Wrap the promise in a `try...catch` so that if it rejects, `delete cache[key]` clears the failed entry to allow subsequent retries.',
        edgeCases: [
          '**Concurrent calls**: 3+ simultaneous requests for the same key must execute `fetcher()` exactly 1 time.',
          '**Identical resolved values**: all concurrent callers must resolve to the identical value.',
          '**Failed fetcher cleanup**: if `fetcher()` rejects, clear `cache[key]` so future calls can retry.',
          '**Cached hits**: subsequent calls after resolution should return the cached value immediately without invoking `fetcher()`.',
        ],
        codeSnippet: `const cache = {};

async function get(key, fetcher) {
  // If already in cache (either pending Promise or resolved value), return it
  if (cache[key]) {
    return cache[key];
  }

  // Cache the in-flight Promise immediately
  cache[key] = (async () => {
    try {
      const val = await fetcher();
      return val;
    } catch (err) {
      // Clean up on failure so retries can trigger fetcher again
      delete cache[key];
      throw err;
    }
  })();

  return cache[key];
}`,
        suggestions: [
          '💡 How does Promise caching prevent race conditions?',
          '🔄 How do I handle fetch failures and retries?',
          '🛠️ Show me the fixed async get() function',
          '📋 Review my current code',
        ],
      }

    case 'AD3':
      return {
        name: 'Python — Mutating a list while iterating',
        language: 'python',
        rootCause:
          'When iterating through a list using `for u in users:`, Python maintains an internal index pointer (0, 1, 2...). When `users.remove(u)` is called, the element is deleted and all subsequent elements shift left by one index. The iterator then advances to the next index, inadvertently skipping the element that just shifted into the current index. This causes consecutive inactive users to be missed.',
        fixSummary:
          'Do not mutate the list while iterating forward. Instead, construct a new filtered list using a list comprehension (`[u for u in users if u.get("active") is not False]`), or iterate over a shallow copy / in reverse.',
        edgeCases: [
          '**Consecutive inactive items**: e.g., `[active, inactive, inactive, active]`. The second inactive user must not be skipped.',
          '**Preserving order**: the order of remaining active users must be strictly preserved.',
          '**Empty lists or lists with no inactive users**: must return expected result without raising exceptions.',
          '**Clear explanation**: explain the root cause in a code comment as requested.',
        ],
        codeSnippet: `def remove_inactive(users):
    # Root Cause: Mutating a list in-place (users.remove(u)) while iterating forward
    # shifts subsequent elements left by 1 index, causing the iterator pointer to
    # skip the next element.
    # Fix: Construct a new list using a list comprehension to preserve order safely.
    if not isinstance(users, list):
        return []
    return [u for u in users if u.get('active') is not False]`,
        suggestions: [
          '💡 Why does Python skip items when removing during a loop?',
          '🛠️ What is the cleanest fix using list comprehension?',
          '🔍 What edge cases are tested for AD3?',
          '📋 Review my current code',
        ],
      }

    case 'AF1':
      return {
        name: 'Feature: Build a sliding-window rate limiter',
        language: 'javascript',
        rootCause:
          'A sliding-window rate limiter needs to track timestamps per user within a rolling duration (`windowMs`). Expired timestamps older than `now - windowMs` must be pruned so memory does not grow unbounded. The Express middleware must extract the client identifier, check `isAllowed()`, set `Retry-After: <seconds>` header, and respond with HTTP 429 when blocked.',
        fixSummary:
          'Maintain a `Map` or hash table mapping `userId -> timestamp[]`. On each request: filter timestamps to keep only `t > now - windowMs`. If `timestamps.length < maxRequests`, push `now` and return `true`. Otherwise return `false`. In Express middleware: if `!isAllowed()`, set `Retry-After` in seconds and return HTTP 429.',
        edgeCases: [
          '**Window Sliding**: requests made 61 seconds ago should expire and allow new requests.',
          '**Multiple users**: user A reaching the limit must not affect user B.',
          '**Memory cleanup**: ensure arrays do not store millions of old timestamps.',
          '**HTTP 429 & Retry-After**: middleware must set header `Retry-After: Math.ceil(windowMs / 1000)` and status 429.',
        ],
        codeSnippet: `// In-memory sliding-window store: userId -> array of timestamps
const userTimestamps = new Map();

function isAllowed(userId, maxRequests = 5, windowMs = 60000) {
  const now = Date.now();
  
  if (!userTimestamps.has(userId)) {
    userTimestamps.set(userId, []);
  }

  // 1. Clean expired timestamps outside the rolling window
  const active = userTimestamps.get(userId).filter(ts => now - ts < windowMs);

  // 2. Check if within limit
  if (active.length < maxRequests) {
    active.push(now);
    userTimestamps.set(userId, active);
    return true;
  }

  // Update cleaned list even when blocked
  userTimestamps.set(userId, active);
  return false;
}

// Express Middleware implementation
function rateLimitMiddleware(req, res, next) {
  const userId = req.ip || req.headers['x-user-id'] || 'anonymous';
  const windowMs = 60000;
  const maxRequests = 5;

  if (isAllowed(userId, maxRequests, windowMs)) {
    return next();
  }

  // Set HTTP 429 and Retry-After header (in seconds)
  const retryAfterSec = Math.ceil(windowMs / 1000);
  res.setHeader('Retry-After', retryAfterSec);
  return res.status(429).json({
    error: 'Too Many Requests',
    message: \`Rate limit exceeded. Please retry in \${retryAfterSec} seconds.\`
  });
}`,
        suggestions: [
          '💡 How does the sliding window algorithm work?',
          '🌐 How do I write the Express middleware with 429 status?',
          '🧹 How do I clean expired timestamps to prevent memory leaks?',
          '📋 Review my rate limiter implementation',
        ],
      }

    default:
      return {
        name: 'Technical Coding Task',
        language: 'text',
        rootCause: 'Inspect the task requirements, edge cases, and test harness.',
        fixSummary: 'Write clean, defensive code handling boundary conditions.',
        edgeCases: ['Null/undefined inputs', 'Out-of-range parameters', 'Type checking'],
        codeSnippet: `// Code implementation here`,
        suggestions: ['💡 Give me a hint', '🔍 What edge cases should I handle?', '📋 Review my code'],
      }
  }
}

function analyzeUserCode(taskId: string, code: string): string {
  const c = (code || '').trim()
  if (!c) {
    return 'Your editor is currently empty. You can write your solution above or ask me for a step-by-step guide on how to solve this task!'
  }

  const cl = c.toLowerCase()

  if (taskId === 'AD1') {
    const hasZeroIndexFix = /page\s*-\s*1|page\s*-\s*size|start\s*=\s*\(?page\s*-\s*1\)?/.test(cl)
    const hasZeroOrNegativeCheck = /page\s*<\s*1|size\s*<=?\s*0|<=?\s*0/.test(cl)
    const hasBeyondCheck = /len\s*\(|start\s*>=\s*len|min\(/.test(cl)

    const notes: string[] = []
    if (hasZeroIndexFix) {
      notes.push('✅ **1-based index calculation**: You correctly adjusted the `(page - 1) * size` offset.')
    } else {
      notes.push('⚠️ **Index calculation**: Make sure `page=1` calculates `start = 0`. Use `start = (page - 1) * size`.')
    }

    if (hasZeroOrNegativeCheck) {
      notes.push('✅ **Edge cases**: You are checking for `page < 1` and `size <= 0`.')
    } else {
      notes.push('⚠️ **Validation**: Add checks for `page < 1` and `size <= 0` to return `[]`.')
    }

    if (hasBeyondCheck) {
      notes.push('✅ **Boundary check**: You check if `start >= len(items)`.')
    }

    return `### 🔍 Review of your draft code:\n\n${notes.join('\n\n')}\n\n**Tip:** Click **"▶ Run hidden tests"** above to verify your solution against all 4 test cases!`
  }

  if (taskId === 'AD2') {
    const cachesPromise = /cache\[key\]\s*=\s*(async|\(?new\s+promise|fetcher\(\))/i.test(cl) || /inflight|pending/i.test(cl)
    const handlesFailure = /delete\s+cache\[key\]|try\s*\{[\s\S]*catch/i.test(cl)
    const returnsCache = /return\s+cache\[key\]/i.test(cl)

    const notes: string[] = []
    if (cachesPromise) {
      notes.push('✅ **Promise Caching**: You cache the in-flight Promise immediately so concurrent callers share the same fetch.')
    } else {
      notes.push('⚠️ **Race Condition Warning**: Ensure you store the pending Promise in `cache[key]` *before* awaiting `fetcher()`.')
    }

    if (handlesFailure) {
      notes.push('✅ **Error Recovery**: You clean up `cache[key]` upon failure to enable retries.')
    } else {
      notes.push('⚠️ **Error Handling**: Wrap the fetch in a `try...catch` and `delete cache[key]` on error so failed calls can retry.')
    }

    if (returnsCache) {
      notes.push('✅ **Return Value**: Returning the cached promise.')
    }

    return `### 🔍 Review of your draft code:\n\n${notes.join('\n\n')}\n\n**Tip:** Click **"▶ Run hidden tests"** above to test concurrent fetches and failure retries!`
  }

  if (taskId === 'AD3') {
    const usesListComp = /\[.*for.*in.*if.*\]/.test(cl) || /filter\s*\(/.test(cl)
    const avoidsMutate = !/\.remove\s*\(/.test(cl)
    const checksActive = /active/.test(cl)

    const notes: string[] = []
    if (avoidsMutate && (usesListComp || checksActive)) {
      notes.push('✅ **Safe Filtering**: You avoid modifying the list while iterating, preserving order and preventing skipped elements.')
    } else if (!avoidsMutate) {
      notes.push('⚠️ **List Mutation Warning**: `users.remove(u)` inside the loop will skip consecutive inactive users. Use a list comprehension `[u for u in users if u.get("active") is not False]`.')
    }

    return `### 🔍 Review of your draft code:\n\n${notes.join('\n\n')}\n\n**Tip:** Click **"▶ Run hidden tests"** above to test your fix against consecutive inactive items!`
  }

  if (taskId === 'AF1') {
    const hasFilter = /filter|date\.now|performance\.now/.test(cl)
    const hasAllowedFn = /isallowed|is_allowed/.test(cl)
    const hasMiddleware = /middleware|429|retry-after|status\(429\)/.test(cl)

    const notes: string[] = []
    if (hasAllowedFn && hasFilter) {
      notes.push('✅ **Sliding Window Logic**: You filter timestamps older than `now - windowMs`.')
    } else {
      notes.push('⚠️ **Sliding Window**: Store timestamps in an array per user and filter with `now - ts < windowMs`.')
    }

    if (hasMiddleware) {
      notes.push('✅ **Express Integration**: Middleware returns HTTP 429 and `Retry-After` header.')
    } else {
      notes.push('⚠️ **Express Middleware**: Include the middleware function returning `res.status(429)` and `res.setHeader("Retry-After", seconds)`.')
    }

    return `### 🔍 Review of your draft code:\n\n${notes.join('\n\n')}\n\n**Tip:** Click **"▶ Run feature tests"** above to test the rate limiter!`
  }

  return `Your code looks like a good start. Click **Run Tests** above to execute it against test cases.`
}

function generateHeuristicResponse(req: AssistantRequest): AssistantResponse {
  const { taskId, messages, currentCode } = req
  const knowledge = getTaskKnowledge(taskId)
  const lastMsg = messages[messages.length - 1]?.content || ''
  const q = lastMsg.toLowerCase()

  let reply = ''

  // 1. Check if user wants code review
  if (
    q.includes('review') ||
    q.includes('check my code') ||
    q.includes('is this right') ||
    q.includes('look at my code') ||
    q.includes('evaluate my code')
  ) {
    reply = analyzeUserCode(taskId, currentCode || '')
  }
  // 2. Check if user wants root cause / explanation of bug
  else if (
    q.includes('root cause') ||
    q.includes('explain the bug') ||
    q.includes('why is this happening') ||
    q.includes('why does') ||
    q.includes('explain') ||
    q.includes('what is the problem')
  ) {
    reply = `### 🐛 Root Cause Explanation for ${knowledge.name}\n\n${knowledge.rootCause}\n\n### 💡 The Fix:\n${knowledge.fixSummary}\n\nWould you like to see a complete code example or explore edge cases?`
  }
  // 3. Check if user asks about edge cases
  else if (
    q.includes('edge case') ||
    q.includes('test case') ||
    q.includes('boundary') ||
    q.includes('fail') ||
    q.includes('what is tested')
  ) {
    reply = `### 🛡️ Edge Cases Tested for ${knowledge.name}\n\nHere are the critical boundary conditions evaluated by the test runner:\n\n`
    knowledge.edgeCases.forEach((e) => {
      reply += `- ${e}\n`
    })
    reply += `\nMake sure your function handles these cases without crashing or throwing unhandled exceptions!`
  }
  // 4. Check if user asks for solution / code / fix
  else if (
    q.includes('show code') ||
    q.includes('give me the code') ||
    q.includes('solution') ||
    q.includes('how to fix') ||
    q.includes('corrected function') ||
    q.includes('show fix') ||
    q.includes('code snippet') ||
    q.includes('write the code') ||
    q.includes('implement')
  ) {
    reply = `### 🛠️ Corrected Solution for ${knowledge.name}\n\nHere is a complete, robust implementation designed to pass all hidden tests:\n\n\`\`\`${knowledge.language}\n${knowledge.codeSnippet}\n\`\`\`\n\n### 📌 Key Highlights:\n- **Clean logic**: Directly addresses the root cause.\n- **Defensive guards**: Handles boundary and edge cases smoothly.\n- You can copy this or click **"Apply to Editor"** on the snippet!`
  }
  // 5. Check if user asks about hints / approach
  else if (q.includes('hint') || q.includes('approach') || q.includes('how do i start') || q.includes('help')) {
    reply = `### 💡 Strategy & Hints for ${knowledge.name}\n\n1. **Understand the index/concurrency model**: ${knowledge.fixSummary}\n2. **Handle Edge Cases**: ${knowledge.edgeCases[0]}\n3. **Test thoroughly**: Run the hidden tests as you make changes.\n\nWould you like a code snippet or a review of your current code?`
  }
  // 6. Generic/fallback response for any other query
  else {
    reply = `### 🤖 CalibiAI Coding Assistant (${knowledge.name})\n\nRegarding your question: "${lastMsg}"\n\n- **Core Concept**: ${knowledge.fixSummary}\n- **Edge Cases to Remember**: ${knowledge.edgeCases.slice(0, 2).join('; ')}\n\n\`\`\`${knowledge.language}\n${knowledge.codeSnippet}\n\`\`\`\n\nFeel free to ask me to review your code or explain any specific part of this problem!`
  }

  return {
    reply,
    engine: 'heuristic',
    suggestions: knowledge.suggestions,
  }
}

// ---------------------------------------------------------------------------
// Main Assistant Export
// ---------------------------------------------------------------------------

export async function chatWithAssistant(req: AssistantRequest): Promise<AssistantResponse> {
  const { taskId, taskTitle, taskPrompt, buggyOrSpec, currentCode, messages } = req
  const knowledge = getTaskKnowledge(taskId)

  if (isCalibiAiConfigured()) {
    const systemPrompt = `You are the CalibiAI Coding Assistant embedded inside a proctored graduate hiring assessment.
The student is working on Stage 3/4 (${taskId}: "${taskTitle || knowledge.name}").
Proctoring rules strictly prevent tab switching, so you are their in-exam companion.

TASK DETAILS:
- Task ID: ${taskId}
- Title: ${taskTitle || knowledge.name}
- Requirement / Prompt: ${taskPrompt || ''}
- Buggy Code or Spec:
"""
${buggyOrSpec || ''}
"""
- Student's Current Code Draft:
"""
${currentCode || '(empty)'}
"""

GUIDELINES:
1. Help the student understand root causes, algorithmic approaches, concurrency, and edge cases.
2. Provide clear, well-structured, educational explanations.
3. When providing code, write complete, production-ready code with appropriate comments in Markdown code blocks (e.g., \`\`\`${knowledge.language}).
4. If they ask to review their code, highlight what is correct and point out bugs or missing edge cases constructively.
5. Be concise, polite, encouraging, and accurate.`

    const calibiAiReply = await callCalibiAiChat(systemPrompt, messages)
    if (calibiAiReply) {
      return {
        reply: calibiAiReply,
        engine: 'calibiai',
        suggestions: knowledge.suggestions,
      }
    }
  }

  // Heuristic knowledge engine fallback
  return generateHeuristicResponse(req)
}
