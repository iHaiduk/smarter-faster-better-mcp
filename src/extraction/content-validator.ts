import type { ExtractedSymbol, QueryAnalysis, ScoutConfig } from '../shared/types/index.js'

const DET_RELEVANCE_THRESHOLD = 0.15
const KEEP_THRESHOLD = 0.5

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
 * Validates extracted symbols against the original query to filter out false positives.
 * Purely deterministic: scores each symbol's code content against query terms.
 */
export async function validateExtractedSymbols(
  symbols: readonly ExtractedSymbol[],
  task: string,
  analysis: QueryAnalysis | null,
  _config?: ScoutConfig,
): Promise<readonly ExtractedSymbol[]> {
  if (symbols.length === 0) return symbols

  const scored = symbols.map((sym) => ({
    sym,
    score: deterministicRelevance(sym, task, analysis),
  }))

  const kept: ExtractedSymbol[] = []
  const rejected: string[] = []

  for (const { sym, score } of scored) {
    if (score >= DET_RELEVANCE_THRESHOLD) {
      kept.push(sym)
    } else {
      rejected.push(`${sym.candidate.file}::${sym.candidate.symbol} (score=${score.toFixed(2)})`)
    }
  }

  if (rejected.length > 0) {
    console.error(`[Scout] Content validation rejected ${rejected.length} symbols: ${rejected.join(', ')}`)
  }

  if (kept.length === 0 && symbols.length > 0) {
    console.error('[Scout] All symbols failed content validation. Keeping top match as fallback.')
    return [symbols[0]!]
  }

  return kept
}
