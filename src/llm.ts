// Refactored: 2026-05-21 — modern JS/TS
// Cheap-LLM client + JSON cleanup. Re-exports getGitHint for back-compat.
import { SYSTEM_PROMPT } from './config.js'

import type { LLMCandidate, LLMResponse, ScoutConfig } from './types.js'

export { getGitHint } from './git.js'

interface ChatCompletionResponse {
  readonly choices: ReadonlyArray<{ readonly message?: { readonly content?: string } }>
}

/** Strips markdown fences / surrounding text to isolate a JSON payload. */
export function cleanJSON(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) return fenced[1].trim()

  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) return raw.slice(start, end + 1)

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
        max_tokens: 300,
        temperature: 0,
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
    const raw = data.choices.at(0)?.message?.content ?? ''
    const parsed = JSON.parse(cleanJSON(raw)) as LLMResponse

    if (!Array.isArray(parsed.candidates) || parsed.candidates.length === 0) return null
    return parsed.candidates
  } catch (err) {
    if (!(err instanceof Error) || err.name !== 'AbortError') {
      console.error('[Scout] LLM request failed:', err instanceof Error ? err.message : String(err))
    }
    return null
  }
}

/** Dispatches the symbol map to the cheap LLM in parallel chunks; merges candidates. */
export async function askCheapLLM(
  task: string,
  compactMaps: readonly string[],
  gitHint: string,
  config: ScoutConfig,
): Promise<LLMCandidate[] | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.llmTimeoutMs)

  try {
    const requests = compactMaps.map((chunkMap) => {
      const userContent = [
        `Task: ${task}`,
        gitHint && `Recently modified: ${gitHint}`,
        `Symbols:\n${chunkMap}`,
      ]
        .filter(Boolean)
        .join('\n\n')

      return singleLLMRequest(userContent, config, controller.signal)
    })

    const results = await Promise.all(requests)

    // Deduplicate by file::symbol, keeping the highest confidence.
    const best = new Map<string, LLMCandidate>()
    for (const candidates of results) {
      if (!candidates) continue
      for (const candidate of candidates) {
        const key = `${candidate.file}::${candidate.symbol}`
        const existing = best.get(key)
        if (!existing || existing.confidence < candidate.confidence) {
          best.set(key, candidate)
        }
      }
    }

    if (best.size === 0) return null
    return [...best.values()]
  } catch {
    console.error('[Scout] All parallel LLM requests failed or returned empty')
    return null
  } finally {
    clearTimeout(timeout)
  }
}
