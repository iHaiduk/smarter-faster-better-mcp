// Refactored: 2026-05-21 — modern JS/TS
// Cheap-LLM client + JSON cleanup. Re-exports getGitHint for back-compat.
import { SYSTEM_PROMPT } from './config.js'

import type { LLMCandidate, LLMResponse, ScoutConfig } from './types.js'

export { getGitHint } from './git.js'

interface ChatCompletionResponse {
  readonly choices: ReadonlyArray<{ readonly message?: { readonly content?: string } }>
}

/** Strips markdown fences / surrounding text to isolate a JSON payload (objects or arrays). */
export function cleanJSON(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) return fenced[1].trim()

  const startObj = raw.indexOf('{')
  const startArr = raw.indexOf('[')

  let start = -1
  let end = -1

  if (startObj !== -1 && startArr !== -1) {
    start = Math.min(startObj, startArr)
  } else {
    start = startObj !== -1 ? startObj : startArr
  }

  if (start === startObj) {
    end = raw.lastIndexOf('}')
  } else if (start === startArr) {
    end = raw.lastIndexOf(']')
  }

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
        max_tokens: 300,
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
    const raw = data.choices.at(0)?.message?.content ?? ''
    
    if (!raw.trim()) {
      if (data.choices.at(0)?.message && 'tool_calls' in data.choices[0].message) {
        console.error('[Scout] LLM returned tool calls instead of text content. Retrying with higher temperature might help.')
      }
      return null
    }

    const cleaned = cleanJSON(raw)
    let parsed: any
    try {
      parsed = JSON.parse(cleaned)
    } catch (e) {
      console.error('[Scout] Failed to parse JSON from LLM content:', JSON.stringify(raw))
      return null
    }

    let candidates: any[] = []
    if (Array.isArray(parsed)) {
      candidates = parsed
    } else if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.candidates)) {
        candidates = parsed.candidates
      } else if (Array.isArray(parsed.symbols)) {
        candidates = parsed.symbols
      } else if (Array.isArray(parsed.results)) {
        candidates = parsed.results
      } else if (parsed.file && parsed.symbol) {
        candidates = [parsed]
      }
    }

    const validated = candidates
      .map((c: any) => {
        if (c && typeof c === 'object' && typeof c.file === 'string' && typeof c.symbol === 'string') {
          // Clean the filename of any potential markdown/header artifact prefixes (like '# ', 'File: ', '// ')
          let file = c.file.trim()
          
          while (file.startsWith('#')) {
            file = file.slice(1).trim()
          }
          
          if (file.toLowerCase().startsWith('file:')) {
            file = file.slice(5).trim()
          } else if (file.startsWith('//')) {
            file = file.slice(2).trim()
          }

          return {
            file,
            symbol: c.symbol,
            confidence: typeof c.confidence === 'number' ? c.confidence : 1.0,
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

/** Dispatches the symbol map to the cheap LLM in parallel chunks; merges candidates. Retries up to 2 times on failure. */
export async function askCheapLLM(
  task: string,
  compactMaps: readonly string[],
  gitHint: string,
  config: ScoutConfig,
): Promise<LLMCandidate[] | null> {
  const maxAttempts = 2
  
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.llmTimeoutMs)
    
    // Attempt 1 uses temperature 0 (greedy). Attempt 2 uses 0.3 to break out of deterministic hallucinations.
    const temp = attempt === 1 ? 0 : 0.3

    try {
      const requests = compactMaps.map((chunkMap) => {
        const userContent = [
          `Task: ${task}`,
          gitHint && `Recently modified: ${gitHint}`,
          `Symbols:\n${chunkMap}`,
        ]
          .filter(Boolean)
          .join('\n\n')

        return singleLLMRequest(userContent, config, controller.signal, temp)
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

      if (best.size > 0) {
        return [...best.values()]
      }

      console.warn(`[Scout] LLM attempt ${attempt}/${maxAttempts} returned no candidates.`)
    } catch (err) {
      console.error(`[Scout] LLM attempt ${attempt}/${maxAttempts} failed:`, err)
    } finally {
      clearTimeout(timeout)
    }
  }

  console.error('[Scout] All parallel LLM requests failed after all attempts')
  return null
}
