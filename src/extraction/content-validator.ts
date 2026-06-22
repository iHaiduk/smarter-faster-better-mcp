import { cleanJSON } from '../shared/utils/json.js'
import { llmFetch } from '../shared/utils/llm-client.js'

import type { ExtractedSymbol, QueryAnalysis, ScoutConfig } from '../shared/types/index.js'

const DET_RELEVANCE_THRESHOLD = 0.15
const KEEP_THRESHOLD = 0.5
const MAX_BORDERLINE_FOR_LLM = 10
const MAX_LLM_OUTPUT_TOKENS = 300
const MAX_LLM_TIMEOUT_MS = 8_000

/**
 * Deterministic content relevance score.
 * Checks if keywords from the query and analysis expanded terms appear in the extracted code.
 * Returns a score between 0 and 1.
 */
function deterministicRelevance(
  symbol: ExtractedSymbol,
  task: string,
  analysis: QueryAnalysis | null,
): number {
  const codeLower = (symbol.code + ' ' + symbol.signature + ' ' + symbol.doc).toLowerCase()

  const queryWords = task
    .toLowerCase()
    .split(/[\s\W_]+/)
    .filter((w) => w.length >= 3)

  const expandedWords = analysis
    ? analysis.expandedTerms.flatMap((t) =>
        t.toLowerCase().split(/[\s\W_]+/).filter((w) => w.length >= 3),
      )
    : []

  const allTerms = [...new Set([...queryWords, ...expandedWords])]
  if (allTerms.length === 0) return KEEP_THRESHOLD

  let matchedCount = 0
  for (const term of allTerms) {
    if (codeLower.includes(term)) {
      matchedCount++
    }
  }

  const ratio = matchedCount / allTerms.length

  // Symbol name match from analysis is a strong signal — override score
  if (analysis) {
    const symLower = symbol.candidate.symbol.toLowerCase()
    for (const name of analysis.symbolNames) {
      if (symLower.includes(name.toLowerCase()) || name.toLowerCase().includes(symLower)) {
        return Math.max(ratio + 0.3, 0.9)
      }
    }
  }

  return ratio
}

/**
 * LLM batch validation — sends all borderline symbols to the LLM in one call
 * asking which ones actually implement the user's requested feature.
 */
async function llmBatchValidate(
  task: string,
  symbols: readonly ExtractedSymbol[],
  analysis: QueryAnalysis | null,
  config: ScoutConfig,
): Promise<Set<string>> {
  if (symbols.length === 0) return new Set()

  const symbolSummaries = symbols
    .map((s, i) => {
      const codePreview = s.code.split('\n').slice(0, 8).join('\n')
      return `[${i}] ${s.candidate.file}::${s.candidate.symbol}\nSignature: ${s.signature}\nCode:\n${codePreview}`
    })
    .join('\n\n')

  const analysisContext = analysis
    ? [
        `Intent: ${analysis.intent}`,
        analysis.symbolNames.length > 0 && `Expected symbols: ${analysis.symbolNames.join(', ')}`,
        analysis.expandedTerms.length > 0 && `Key concepts: ${analysis.expandedTerms.join(', ')}`,
      ]
        .filter(Boolean)
        .join('\n')
    : ''

  const userContent = [
    `User query: "${task}"`,
    `What user wants: ${analysis?.description ?? task}`,
    analysisContext && `Analysis hints:\n${analysisContext}`,
    `---`,
    `Below are extracted code symbols. For EACH symbol, reply with index and whether it is relevant.`,
    `A symbol is relevant if its code implements, defines, or directly relates to what the user asked about.`,
    `A symbol is NOT relevant if it only matches by name but the code is about something different.`,
    `Output ONLY valid JSON: {"verdicts":[{"idx":0,"relevant":true,"reason":"..."}]}`,
    ``,
    symbolSummaries,
  ]
    .filter(Boolean)
    .join('\n\n')

  const raw = await llmFetch(
    config.baseUrl,
    config.apiKey,
    [
      {
        role: 'system',
        content:
          'You are a code relevance judge. Given a user query and extracted code symbols, determine which symbols actually implement what the user wants. Be strict — only mark relevant if the code directly relates to the query.',
      },
      { role: 'user', content: userContent },
    ],
    { model: config.model, maxTokens: MAX_LLM_OUTPUT_TOKENS, timeoutMs: Math.min(MAX_LLM_TIMEOUT_MS, config.llmTimeoutMs) },
  )

  // On any failure, keep all symbols (graceful degradation)
  if (!raw) {
    return new Set(symbols.map((s) => `${s.candidate.file}::${s.candidate.symbol}`))
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleanJSON(raw)) as Record<string, unknown>
  } catch {
    console.error('[Scout] Content validator: failed to parse LLM response')
    return new Set(symbols.map((s) => `${s.candidate.file}::${s.candidate.symbol}`))
  }

  const rawVerdicts = parsed['verdicts']
  const verdicts = Array.isArray(rawVerdicts) ? rawVerdicts : []

  const relevantSet = new Set<string>()
  for (const v of verdicts) {
    if (v === null || typeof v !== 'object') continue
    const entry = v as Record<string, unknown>
    if (typeof entry['idx'] !== 'number' || typeof entry['relevant'] !== 'boolean') continue
    const sym = symbols[entry['idx']]
    if (!sym) continue

    const key = `${sym.candidate.file}::${sym.candidate.symbol}`
    if (entry['relevant']) {
      relevantSet.add(key)
    } else {
      const reason = typeof entry['reason'] === 'string' ? entry['reason'] : 'not relevant'
      console.error(`[Scout] Content validation rejected: ${key} — ${reason}`)
    }
  }

  // If LLM returned no verdicts, keep all (graceful degradation)
  if (relevantSet.size === 0) {
    return new Set(symbols.map((s) => `${s.candidate.file}::${s.candidate.symbol}`))
  }

  return relevantSet
}

/**
 * Validates extracted symbols against the original query to filter out false positives.
 *
 * 1. Deterministic check: scores each symbol's code content against query/analysis terms.
 * 2. Symbols with score >= KEEP_THRESHOLD are kept immediately.
 * 3. Borderline symbols (score >= DET_RELEVANCE_THRESHOLD) go to LLM batch validation.
 * 4. Returns filtered list with only relevant symbols.
 */
export async function validateExtractedSymbols(
  symbols: readonly ExtractedSymbol[],
  task: string,
  analysis: QueryAnalysis | null,
  config: ScoutConfig,
): Promise<readonly ExtractedSymbol[]> {
  if (symbols.length === 0) return symbols

  const scored = symbols.map((sym) => ({
    sym,
    score: deterministicRelevance(sym, task, analysis),
  }))

  const kept: ExtractedSymbol[] = []
  const borderline: ExtractedSymbol[] = []
  const rejected: string[] = []

  for (const { sym, score } of scored) {
    if (score >= KEEP_THRESHOLD) {
      kept.push(sym)
    } else if (score >= DET_RELEVANCE_THRESHOLD) {
      borderline.push(sym)
    } else {
      rejected.push(`${sym.candidate.file}::${sym.candidate.symbol} (score=${score.toFixed(2)})`)
    }
  }

  if (rejected.length > 0) {
    console.error(`[Scout] Content validation rejected ${rejected.length} symbols: ${rejected.join(', ')}`)
  }

  // Cap borderline to avoid excessive LLM token usage
  let llmKept = new Set<string>()
  if (borderline.length > 0) {
    const toValidate = borderline.slice(0, MAX_BORDERLINE_FOR_LLM)
    if (borderline.length > MAX_BORDERLINE_FOR_LLM) {
      console.error(`[Scout] Capping borderline validation: ${borderline.length} → ${MAX_BORDERLINE_FOR_LLM}`)
    }
    llmKept = await llmBatchValidate(task, toValidate, analysis, config)
  }

  const llmAccepted = borderline.filter((sym) =>
    llmKept.has(`${sym.candidate.file}::${sym.candidate.symbol}`),
  )

  const result = [...kept, ...llmAccepted]

  if (result.length === 0 && symbols.length > 0) {
    console.error('[Scout] All symbols failed content validation. Keeping top match as fallback.')
    return [symbols[0]!]
  }

  return result
}
