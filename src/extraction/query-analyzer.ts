import { cleanJSON } from '../shared/utils/json.js'
import { llmFetch } from '../shared/utils/llm-client.js'
import { getCachedAnalysis, setCachedAnalysis } from '../cache/query-cache.js'

import type { QueryAnalysis, QueryIntent, ScoutConfig } from '../shared/types/index.js'

const ANALYSIS_PROMPT = `You are a code search query analyzer. Given a user's natural language query, extract structured search information.

Classify the query intent into one of:
- "specificSymbol": user names a specific function/hook/class/component (e.g. "useChatRoomPresence", "UserService", "ChatRoom component")
- "featureSearch": user describes a feature or behavior (e.g. "online status", "user authentication", "real-time updates")
- "conceptSearch": user asks about a concept or pattern (e.g. "state management", "error handling", "caching strategy")
- "fileSearch": user asks about a specific file or directory (e.g. "config file", "routes", "constants")

Extract:
- symbolNames: likely exact code identifiers mentioned (camelCase/PascalCase names, hooks, components)
- expandedTerms: additional search terms that would match related code (synonyms, related concepts, common naming patterns)
- filePatterns: likely file name patterns (e.g. "presence", "chat", "status", "hook")
- description: one-line summary of what the user is looking for

Output ONLY valid JSON:
{"intent":"...","symbolNames":[...],"expandedTerms":[...],"filePatterns":[...],"description":"..."}`

const MAX_TIMEOUT_MS = 5_000
const MAX_OUTPUT_TOKENS = 200

const VALID_INTENTS: ReadonlySet<QueryIntent> = new Set([
  'specificSymbol',
  'featureSearch',
  'conceptSearch',
  'fileSearch',
])

/** Quick heuristic check: does the query contain something that looks like a code identifier? */
function hasCodeIdentifier(task: string): boolean {
  return /\b(use[A-Z]|[A-Z][a-z]+[A-Z]|[a-z]+_[a-z]+_[a-z]+)\w*\b/.test(task)
}

const toStringArray = (val: unknown): string[] =>
  Array.isArray(val) ? val.filter((v): v is string => typeof v === 'string') : []

/**
 * Analyzes a natural language query using a cheap LLM call to extract
 * structured search information: intent, symbol names, expanded terms, file patterns.
 *
 * Returns null on failure so the pipeline can fall back to keyword-based search.
 * Results are cached to avoid repeated LLM calls for similar queries.
 */
export async function analyzeQuery(
  task: string,
  config: ScoutConfig,
): Promise<QueryAnalysis | null> {
  if (task.length < 5) return null
  if (/^[a-zA-Z_]\w+$/.test(task.trim())) return null

  const cached = getCachedAnalysis(task)
  if (cached) {
    console.error('[Scout] Query analysis: cache hit')
    return cached
  }

  const raw = await llmFetch(
    config.baseUrl,
    config.apiKey,
    [{ role: 'system', content: ANALYSIS_PROMPT }, { role: 'user', content: task }],
    { model: config.model, maxTokens: MAX_OUTPUT_TOKENS, timeoutMs: Math.min(MAX_TIMEOUT_MS, config.llmTimeoutMs) },
  )

  if (!raw) return null

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleanJSON(raw)) as Record<string, unknown>
  } catch {
    console.error('[Scout] Query analyzer: failed to parse LLM response')
    return null
  }

  const intent = VALID_INTENTS.has(parsed['intent'] as QueryIntent)
    ? (parsed['intent'] as QueryIntent)
    : 'conceptSearch'

  let symbolNames = toStringArray(parsed['symbolNames'])
  if (symbolNames.length === 0 && hasCodeIdentifier(task)) {
    symbolNames = task.match(/\b(use[A-Z]\w*|[A-Z][a-z]+[A-Z]\w*|[a-z]+_[a-z]+_\w+)\b/g) ?? []
  }

  const analysis: QueryAnalysis = {
    intent,
    symbolNames,
    expandedTerms: toStringArray(parsed['expandedTerms']),
    filePatterns: toStringArray(parsed['filePatterns']),
    description: typeof parsed['description'] === 'string' ? parsed['description'] : task,
  }

  setCachedAnalysis(task, analysis)
  return analysis
}
