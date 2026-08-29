// Cheap-LLM client.
import { SYSTEM_PROMPT } from '../config/index.js'
import { cleanJSON } from '../shared/utils/json.js'
import { llmFetch } from '../shared/utils/llm-client.js'

import type { LLMCandidate, RelevanceTier, ScoutConfig, QueryAnalysis } from '../shared/types/index.js'

const MAX_LLM_OUTPUT_TOKENS = 300

const VALID_TIERS: ReadonlySet<RelevanceTier> = new Set([
  'mustRead',
  'likelyRelevant',
  'dependencyOnly',
  'testsOrExamples',
  'excluded',
])

function parseCandidates(raw: string): readonly LLMCandidate[] | null {
  const cleaned = cleanJSON(raw)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    console.error('[Scout] Failed to parse JSON from LLM content:', JSON.stringify(raw))
    return null
  }

  let candidates: unknown[] = []
  if (Array.isArray(parsed)) {
    candidates = parsed
  } else if (parsed !== null && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    if (Array.isArray(obj['candidates'])) {
      candidates = obj['candidates']
    } else if (Array.isArray(obj['symbols'])) {
      candidates = obj['symbols']
    } else if (Array.isArray(obj['results'])) {
      candidates = obj['results']
    } else if (typeof obj['file'] === 'string' && typeof obj['symbol'] === 'string') {
      candidates = [parsed]
    }
  }

  const validated = candidates
    .map((c: unknown) => {
      if (c === null || typeof c !== 'object' || !('file' in c) || !('symbol' in c)) return null
      const entry = c as Record<string, unknown>
      if (typeof entry['file'] !== 'string' || typeof entry['symbol'] !== 'string') return null

      let file = entry['file'].trim()
      while (file.startsWith('#')) {
        file = file.slice(1).trim()
      }
      if (file.toLowerCase().startsWith('file:')) {
        file = file.slice(5).trim()
      } else if (file.startsWith('//')) {
        file = file.slice(2).trim()
      }

      const confidence = typeof entry['confidence'] === 'number' ? entry['confidence'] : 1.0
      const rawTier = entry['tier']
      return {
        file,
        symbol: entry['symbol'] as string,
        confidence,
        tier: VALID_TIERS.has(rawTier as RelevanceTier) ? (rawTier as RelevanceTier) : undefined,
      } as LLMCandidate
    })
    .filter((c): c is LLMCandidate => c !== null)

  if (validated.length === 0) return null
  return validated
}

async function singleLLMRequest(
  userContent: string,
  config: ScoutConfig,
  signal: AbortSignal,
  temperature = 0,
): Promise<readonly LLMCandidate[] | null> {
  if (!config.model) return null
  const raw = await llmFetch(
    config.baseUrl,
    config.apiKey,
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    { model: config.model, maxTokens: MAX_LLM_OUTPUT_TOKENS, temperature },
    signal,
  )

  if (!raw) return null
  return parseCandidates(raw)
}

/** Merges parallel LLM result sets, keeping the highest-confidence entry per file::symbol key. */
function mergeCandidates(results: ReadonlyArray<readonly LLMCandidate[] | null>): LLMCandidate[] {
  const best = new Map<string, LLMCandidate>()
  for (const batch of results) {
    if (!batch) continue
    for (const candidate of batch) {
      const key = `${candidate.file}::${candidate.symbol}`
      const existing = best.get(key)
      if (!existing || existing.confidence < candidate.confidence) {
        best.set(key, candidate)
      }
    }
  }
  return [...best.values()]
}

/** Dispatches the symbol map to the cheap LLM in parallel chunks; merges candidates. Retries up to 2 times on failure. */
export async function askCheapLLM(
  task: string,
  compactMaps: readonly string[],
  gitHint: string,
  config: ScoutConfig,
  analysis?: QueryAnalysis | null,
): Promise<LLMCandidate[] | null> {
  if (!config.baseUrl || !config.apiKey || !config.model) {
    return null
  }

  const MAX_ATTEMPTS = 2

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.llmTimeoutMs)
    const temperature = attempt === 1 ? 0 : 0.3

    try {
      const requests = compactMaps.map((chunkMap) => {
        const analysisHint = analysis
          ? [
              `Query intent: ${analysis.intent}`,
              analysis.symbolNames.length > 0 && `Look for symbols: ${analysis.symbolNames.join(', ')}`,
              analysis.expandedTerms.length > 0 && `Related terms: ${analysis.expandedTerms.join(', ')}`,
              analysis.filePatterns.length > 0 && `File patterns: ${analysis.filePatterns.join(', ')}`,
              `User wants: ${analysis.description}`,
            ]
              .filter(Boolean)
              .join('\n')
          : ''

        const userContent = [
          `Task: ${task}`,
          analysisHint,
          gitHint && `Recently modified: ${gitHint}`,
          `Symbols:\n${chunkMap}`,
        ]
          .filter(Boolean)
          .join('\n\n')
        return singleLLMRequest(userContent, config, controller.signal, temperature)
      })

      const results = await Promise.all(requests)
      const merged = mergeCandidates(results)

      if (merged.length > 0) return merged

      console.error(`[Scout] LLM attempt ${attempt}/${MAX_ATTEMPTS} returned no candidates.`)
    } catch (err) {
      console.error(`[Scout] LLM attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err)
    } finally {
      clearTimeout(timeout)
    }
  }

  console.error('[Scout] All parallel LLM requests failed after all attempts')
  return null
}
