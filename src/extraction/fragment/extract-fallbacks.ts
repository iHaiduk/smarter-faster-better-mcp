import type { ExtractedSymbol, LLMCandidate, SymbolEntry } from '../../shared/types/index.js'

const FALLBACK_LINES = 20

/** Produces the standard "file not found" ExtractedSymbol. */
export function missingFileResult(candidate: LLMCandidate): ExtractedSymbol {
  return {
    candidate,
    code: `[File not found: ${candidate.file}]`,
    signature: '',
    doc: '',
    imports: [],
    importedBy: [],
    extractionOk: false,
  }
}

/** Extracts a single JSON property value from a parsed object. Returns null if not found. */
export function extractJsonProperty(
  candidate: LLMCandidate,
  source: string,
  mapEntry: SymbolEntry | undefined,
): ExtractedSymbol | null {
  try {
    const parsedJson = JSON.parse(source)
    const foundValue = parsedJson[candidate.symbol]
    if (foundValue === undefined) return null
    return {
      candidate,
      code: `"${candidate.symbol}": ${JSON.stringify(foundValue, null, 2)}`,
      signature: mapEntry?.signature ?? '',
      doc: '',
      imports: [],
      importedBy: [],
      extractionOk: true,
      startLine: 1,
      endLine: 1,
      typeDefs: [],
      fullLength: JSON.stringify(foundValue).length,
    }
  } catch {
    return null
  }
}

/**
 * Fallback extraction when AST resolution fails.
 * Scans for the symbol by word-boundary regex, returns a context window or
 * a file-start snippet if no match is found.
 *
 * @param declarationKeywords - Language-specific keywords that indicate a declaration line.
 */
export function extractFallback(
  candidate: LLMCandidate,
  source: string,
  mapEntry: SymbolEntry | undefined,
  imports: string[],
  declarationKeywords: string[],
): ExtractedSymbol {
  const lines = source.split('\n')
  const symbolRegex = new RegExp(`\\b${candidate.symbol}\\b`)
  let bestLineIdx = -1

  for (let i = 0; i < lines.length; i++) {
    if (symbolRegex.test(lines[i] ?? '')) {
      bestLineIdx = i
      const lineText = lines[i] ?? ''
      if (declarationKeywords.some((kw) => lineText.includes(kw))) {
        break
      }
    }
  }

  if (bestLineIdx !== -1) {
    const startLineIdx = Math.max(0, bestLineIdx - 5)
    const endLineIdx = Math.min(lines.length - 1, bestLineIdx + 10)
    const codeSnippet = lines.slice(startLineIdx, endLineIdx + 1).join('\n')
    return {
      candidate,
      code: `[Exact AST extraction failed — showing matching line context]\n\n${codeSnippet}`,
      signature: mapEntry?.signature ?? '',
      doc: mapEntry?.doc ?? '',
      imports,
      importedBy: [],
      extractionOk: false,
      startLine: startLineIdx + 1,
      endLine: endLineIdx + 1,
      candidateRanges: [{ startLine: startLineIdx + 1, endLine: endLineIdx + 1 }],
    }
  }

  const startIdx = Math.max(0, lines.findIndex((l) => !l.startsWith('import') && l.trim() !== ''))
  const fallback = lines.slice(startIdx, startIdx + FALLBACK_LINES).join('\n')
  return {
    candidate,
    code: `[Exact AST extraction failed — showing file start fallback]\n\n${fallback}`,
    signature: mapEntry?.signature ?? '',
    doc: mapEntry?.doc ?? '',
    imports,
    importedBy: [],
    extractionOk: false,
    startLine: startIdx + 1,
    endLine: Math.min(lines.length, startIdx + FALLBACK_LINES),
    candidateRanges: [
      { startLine: startIdx + 1, endLine: Math.min(lines.length, startIdx + FALLBACK_LINES) },
    ],
  }
}
