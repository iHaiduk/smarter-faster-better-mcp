import { loadConfig } from '../../config/index.js'
import { cleanJSON } from '../utils/json.js'
import { buildEndpoint } from '../utils/llm-client.js'

const INTERCEPT_SYSTEM_PROMPT = `
You are a File Content Filtering AI. Your job is to intercept file-reading commands, extract ONLY the specific and highly relevant content needed from the file, and score the relevance.

You must respond with a strictly formatted JSON object containing exactly the following three keys:
1. "relevanceScore": a floating point number between 0.0 and 1.0 representing how relevant the content is to the query (or general development if no query is provided).
2. "contextualExplanation": a concise text explanation of why the file is being read, what specific information is relevant, and what was found.
3. "relevantContent": the filtered, high-relevance code content or lines extracted from the original text (excluding boilerplates, unused sections, or irrelevant noise).

Response must be a valid raw JSON object only. Do NOT include markdown blocks, explaining text, or backticks around the JSON.
`

export interface FilteredFileResult {
  readonly relevanceScore: number
  readonly contextualExplanation: string
  readonly relevantContent: string
}

/**
 * Intercepts file reading operations, processes the content via local LLM
 * to perform content filtering, relevance scoring, and contextual explanations.
 * Falls back gracefully to returning full sliced content if the LLM fails.
 */
export async function interceptFileRead(
  file: string,
  rawContent: string,
  query?: string
): Promise<FilteredFileResult> {
  const fallbackResult: FilteredFileResult = {
    relevanceScore: 1.0,
    contextualExplanation: `Direct file context extracted without active AI filtering due to LLM fallback (Read ${rawContent.split('\n').length} lines of ${file}).`,
    relevantContent: rawContent,
  }

  let config
  try {
    config = loadConfig()
  } catch {
    // Config not available (e.g. env vars missing) -> immediate fallback
    return fallbackResult
  }

  const userContent = [
    `Target File Path: ${file}`,
    query ? `Query/Intent: ${query}` : `No specific query provided (analyze general relevance)`,
    `File Content Slice:\n${rawContent}`,
  ].join('\n\n')

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.llmTimeoutMs)

    const res = await fetch(buildEndpoint(config.baseUrl), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 1000, // Grant higher token allowance for filtered content
        temperature: 0,
        messages: [
          { role: 'system', content: INTERCEPT_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
    })

    clearTimeout(timeout)

    if (!res.ok) {
      console.error(`[Scout Filter Interceptor] LLM HTTP ${res.status}. Falling back.`)
      return fallbackResult
    }

    const data = (await res.json()) as {
      choices: ReadonlyArray<{ message?: { content?: string } }>
    }
    const rawOutput = data.choices.at(0)?.message?.content ?? ''
    if (!rawOutput.trim()) {
      return fallbackResult
    }

    const cleaned = cleanJSON(rawOutput)
    const parsed = JSON.parse(cleaned) as Record<string, unknown>

    const relevanceScore =
      typeof parsed['relevanceScore'] === 'number' ? parsed['relevanceScore'] : 1.0
    const contextualExplanation =
      typeof parsed['contextualExplanation'] === 'string'
        ? parsed['contextualExplanation']
        : 'Relevance and explanation extracted.'
    const relevantContent =
      typeof parsed['relevantContent'] === 'string'
        ? parsed['relevantContent']
        : rawContent

    return {
      relevanceScore,
      contextualExplanation,
      relevantContent,
    }
  } catch (err) {
    console.error(
      `[Scout Filter Interceptor] Interception request failed:`,
      err instanceof Error ? err.message : String(err)
    )
    return fallbackResult
  }
}

/** Formats the intercepted and filtered file results into premium developer-friendly markdown. */
export function formatInterceptedMarkdown(
  file: string,
  startLine: number,
  endLine: number,
  result: FilteredFileResult
): string {
  const badge = result.relevanceScore >= 0.8
    ? '🟢 HIGH RELEVANCE'
    : result.relevanceScore >= 0.5
    ? '🟡 MEDIUM RELEVANCE'
    : '🔴 LOW RELEVANCE'

  return [
    `## 🔍 File Context (AI Filtered): ${file} (L${startLine}-${endLine})`,
    `> **Relevance:** ${badge} (${(result.relevanceScore * 100).toFixed(0)}%)`,
    `>`,
    `> **Context & Explanation:** ${result.contextualExplanation}`,
    '',
    '```json',
    result.relevantContent,
    '```',
  ].join('\n')
}
