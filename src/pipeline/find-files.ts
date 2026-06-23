import { getParserMode } from '../config/index.js'
import { getProjectFiles } from '../indexing/symbol-map/build-map.js'
import { matchGlob, normalizePath } from '../shared/utils/glob.js'
import { toStructuredJSON } from '../bundle/formatter/format.js'

import type { ExtractedSymbol } from '../shared/types/index.js'

const FILE_MATCH_SYMBOL = 'FILE_MATCH'

/** Searches files by pattern inside the workspace. */
export async function runFindFiles(pattern: string, targetRoot = process.cwd()): Promise<string> {
  const files = await getProjectFiles(targetRoot, getParserMode())
  const normalizedPattern = normalizePath(pattern)
  const isGlob = normalizedPattern.includes('*') || normalizedPattern.includes('?')
  const patternLower = normalizedPattern.toLowerCase()
  const matches = files.filter((f) => {
    const normalized = normalizePath(f)
    return (
      matchGlob(normalized, normalizedPattern) ||
      (!isGlob && normalized.toLowerCase().includes(patternLower))
    )
  })

  if (matches.length === 0 && isGlob) {
    // Fallback: if exact glob fails, extract words and find files containing all of them
    const withoutBraces = normalizedPattern.replace(/\{[^}]+\}/g, '')
    const terms = Array.from(new Set((withoutBraces.match(/[a-zA-Z0-9_-]+/g) || []).map(t => t.toLowerCase())))
    
    if (terms.length > 0) {
      const fuzzyMatches = files.filter(f => {
        const lower = f.toLowerCase()
        return terms.every(term => lower.includes(term))
      }).slice(0, 100) // Limit to top 100 to avoid context overflow

      if (fuzzyMatches.length > 0) {
        const markdown = [
          `### Found 0 files matching exact pattern: "${pattern}"`,
          `#### Fallback: Found ${fuzzyMatches.length} files containing all terms (${terms.join(', ')}):`,
          ...fuzzyMatches.map((m) => `- ${m}`),
        ].join('\n')

        const results: ExtractedSymbol[] = fuzzyMatches.map((m) => ({
          candidate: { file: m, symbol: FILE_MATCH_SYMBOL, confidence: 0.5 },
          code: '',
          signature: '',
          doc: '',
          imports: [],
          importedBy: [],
          extractionOk: true,
          relevanceTier: 'mustRead' as const,
        }))

        return toStructuredJSON(
          markdown,
          results,
          0.5,
          `Found 0 files matching exact pattern, but discovered ${fuzzyMatches.length} files matching terms: ${terms.join(', ')}.`,
          [],
          [],
        )
      }
    }
  }

  const markdown = [
    `### Found ${matches.length} files matching: "${pattern}"`,
    ...matches.map((m) => `- ${m}`),
  ].join('\n')

  const results: ExtractedSymbol[] = matches.map((m) => ({
    candidate: { file: m, symbol: FILE_MATCH_SYMBOL, confidence: 1.0 },
    code: '',
    signature: '',
    doc: '',
    imports: [],
    importedBy: [],
    extractionOk: true,
    relevanceTier: 'mustRead' as const,
  }))

  return toStructuredJSON(
    markdown,
    results,
    1.0,
    `Discovered ${matches.length} files matching pattern.`,
    [],
    [],
  )
}
