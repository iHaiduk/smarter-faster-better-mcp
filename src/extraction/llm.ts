// Cheap-LLM client + JSON cleanup.
import { SYSTEM_PROMPT } from '../config.js'

import type { LLMCandidate, RelevanceTier, ScoutConfig } from '../types.js'

const MAX_LLM_OUTPUT_TOKENS = 300

const VALID_TIERS: ReadonlySet<RelevanceTier> = new Set([
  'mustRead',
  'likelyRelevant',
  'dependencyOnly',
  'testsOrExamples',
  'excluded',
])

interface ChatCompletionResponse {
  readonly choices: ReadonlyArray<{ readonly message?: { readonly content?: string } }>
}

/** Strips markdown fences / surrounding text to isolate a JSON payload (objects or arrays). */
export function cleanJSON(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) return fenced[1].trim()

  const startObj = raw.indexOf('{')
  const startArr = raw.indexOf('[')

  const start =
    startObj !== -1 && startArr !== -1
      ? Math.min(startObj, startArr)
      : startObj !== -1 ? startObj : startArr

  const end = start === startObj ? raw.lastIndexOf('}') : raw.lastIndexOf(']')

  if (start !== -1 && end !== -1 && end > start) {
    return raw.slice(start, end + 1)
  }

  return raw.trim()
}

function buildEndpoint(baseUrl: string): URL {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return new URL('chat/completions', normalized)
}

async function singleLLMRequest(
  userContent: string,
  config: ScoutConfig,
  signal: AbortSignal,
  temperature = 0,
): Promise<readonly LLMCandidate[] | null> {
  try {
    const res = await fetch(buildEndpoint(config.baseUrl), {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: MAX_LLM_OUTPUT_TOKENS,
        temperature,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
    })

    if (!res.ok) {
      console.error(`[Scout] LLM HTTP ${res.status}`)
      return null
    }

    const data = (await res.json()) as ChatCompletionResponse
    const firstChoice = data.choices.at(0)
    const raw = firstChoice?.message?.content ?? ''
    
    if (!raw.trim()) {
      if (firstChoice?.message && 'tool_calls' in firstChoice.message) {
        console.error('[Scout] LLM returned tool calls instead of text content. Retrying with higher temperature might help.')
      }
      return null
    }

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
        if (c !== null && typeof c === 'object' && 'file' in c && 'symbol' in c) {
          const entry = c as Record<string, unknown>
          if (typeof entry['file'] !== 'string' || typeof entry['symbol'] !== 'string') return null
          // Clean the filename of any potential markdown/header artifact prefixes (like '# ', 'File: ', '// ')
          let file = entry['file'] as string
          file = file.trim()
          while (file.startsWith('#')) {
            file = file.slice(1).trim()
          }
          if (file.toLowerCase().startsWith('file:')) {
            file = file.slice(5).trim()
          } else if (file.startsWith('//')) {
            file = file.slice(2).trim()
          }

          const symbol = entry['symbol'] as string
          const confidence = typeof entry['confidence'] === 'number' ? entry['confidence'] : 1.0
          const rawTier = entry['tier']
          return {
            file,
            symbol,
            confidence,
            tier: VALID_TIERS.has(rawTier as RelevanceTier) ? (rawTier as RelevanceTier) : undefined,
          } as LLMCandidate
        }
        return null
      })
      .filter((c): c is LLMCandidate => c !== null)

    if (validated.length === 0) return null
    return validated
  } catch (err) {
    if (!(err instanceof Error) || err.name !== 'AbortError') {
      console.error('[Scout] LLM request failed:', err instanceof Error ? err.message : String(err))
    }
    return null
  }
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
): Promise<LLMCandidate[] | null> {
  const MAX_ATTEMPTS = 2

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.llmTimeoutMs)
    // Attempt 1 uses temperature 0 (greedy). Attempt 2 uses 0.3 to escape deterministic hallucinations.
    const temperature = attempt === 1 ? 0 : 0.3

    try {
      const requests = compactMaps.map((chunkMap) => {
        const userContent = [
          `Task: ${task}`,
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
