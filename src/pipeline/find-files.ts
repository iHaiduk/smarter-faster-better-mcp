import { getParserMode } from '../config/index.js'
import { getProjectFiles } from '../indexing/symbol-map/build-map.js'
import { globToRegex, normalizePath } from '../shared/utils/glob.js'
import { toStructuredJSON } from '../bundle/formatter/format.js'

import type { ExtractedSymbol } from '../shared/types/index.js'

const FILE_MATCH_SYMBOL = 'FILE_MATCH'

/** Searches files by pattern inside the workspace. */
export async function runFindFiles(pattern: string, targetRoot = process.cwd()): Promise<string> {
  const files = await getProjectFiles(targetRoot, getParserMode())
  const normalizedPattern = normalizePath(pattern)
  const regex = globToRegex(normalizedPattern)
  const isGlob = normalizedPattern.includes('*') || normalizedPattern.includes('?')
  const patternLower = normalizedPattern.toLowerCase()
  const matches = files.filter((f) => {
    const normalized = normalizePath(f)
    return regex.test(normalized) || (!isGlob && normalized.toLowerCase().includes(patternLower))
  })

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
