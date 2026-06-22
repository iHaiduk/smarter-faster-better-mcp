import * as path from 'node:path'
import * as fs from 'node:fs/promises'

import { getParserMode } from '../../config/index.js'
import { getGitStatusMap } from '../../shared/utils/git.js'
import { formatFound, toStructuredJSON } from '../../bundle/formatter/format.js'
import { getProjectFiles } from '../../indexing/symbol-map/build-map.js'
import { readMap } from '../../cache/map-cache.js'
import { resolveBudget } from '../../shared/constants/budget.js'
import { shouldIgnorePath } from '../../shared/constants/ignore-rules.js'
import { matchGlob } from '../../shared/utils/glob.js'

import type { ContextBudgetOptions, ExtractedSymbol, LLMCandidate, ProjectMap } from '../../shared/types/index.js'

// Custom search limits — keep custom regex search bounded to prevent ReDoS / DoS.
const CUSTOM_SEARCH_MAX_PATTERN_LEN = 200
const CUSTOM_SEARCH_MAX_FILE_BYTES = 1_000_000
const CUSTOM_SEARCH_MAX_FILES_SCAN = 500
const CUSTOM_SEARCH_MAX_MATCHES_PER_FILE = 20
const CUSTOM_SEARCH_CONTEXT_LINES = 2

// Trigger pattern for explicit keyword/regex search syntax: "<pattern>" in <glob>
// Strict form: starts with `"`, has paired `" in `, ends with non-empty glob.
const CUSTOM_QUERY_REGEX = /^"([^"]{1,200})"\s+in\s+(\S[^"]{0,200})$/

const BINARY_EXTS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.mp3', '.mp4', '.mov', '.wav', '.ogg', '.webm',
  '.so', '.dll', '.dylib', '.exe', '.bin', '.wasm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
])

export interface CustomQuery {
  readonly pattern: string
  readonly globPattern: string
}

/** Parses a `"<pattern>" in <glob>` query string. Returns null if the syntax doesn't match. */
export function parseCustomQuery(task: string): CustomQuery | null {
  const match = task.trim().match(CUSTOM_QUERY_REGEX)
  if (!match) return null
  const pattern = match[1]?.trim() ?? ''
  const globPattern = match[2]?.trim() ?? ''
  if (!pattern || !globPattern) return null
  if (pattern.length > CUSTOM_SEARCH_MAX_PATTERN_LEN) return null
  // Reject path traversal / absolute globs up-front so file scanning never leaves the workspace.
  if (
    path.isAbsolute(globPattern) ||
    globPattern.startsWith('..') ||
    globPattern.startsWith('/') ||
    globPattern.startsWith('~') ||
    globPattern.includes('/../') ||
    globPattern.includes('\\..\\')
  ) {
    return null
  }
  return { pattern, globPattern }
}

function compileSearchRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, 'i')
  } catch {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(escaped, 'i')
  }
}

/** Returns true when `relPath` resolves strictly inside `root`. */
function isInsideRoot(root: string, relPath: string): boolean {
  if (path.isAbsolute(relPath)) return false
  const resolved = path.resolve(root, relPath)
  const rel = path.relative(root, resolved)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function looksBinary(file: string): boolean {
  return BINARY_EXTS.has(path.extname(file).toLowerCase())
}

/** Runs a literal/regex keyword search across files matching `globPattern`, capped by budget. */
export async function runCustomSearch(
  query: CustomQuery,
  targetRoot: string,
  budget: ContextBudgetOptions,
): Promise<string> {
  const { pattern, globPattern } = query
  const regex = compileSearchRegex(pattern)

  const resolvedBudget = resolveBudget(budget)
  const { maxFiles, maxSymbols, maxChars } = resolvedBudget

  const files = await getProjectFiles(targetRoot, getParserMode())
  const matchedFiles = files.filter((f) => matchGlob(f, globPattern))

  const budgetedResults: ExtractedSymbol[] = []
  const uniqueFiles = new Set<string>()
  let charsCount = 0
  let scanned = 0
  let skipped = 0

  scan: for (const file of matchedFiles) {
    if (scanned >= CUSTOM_SEARCH_MAX_FILES_SCAN) break

    // Skip anything outside the workspace root and well-known noise dirs.
    if (!isInsideRoot(targetRoot, file)) {
      skipped++
      continue
    }
    if (shouldIgnorePath(file)) {
      continue
    }
    if (looksBinary(file)) continue

    scanned++

    const absPath = path.resolve(targetRoot, file)
    let stat
    try {
      stat = await fs.stat(absPath)
    } catch {
      continue
    }
    const size = stat.size
    if (size === 0 || size > CUSTOM_SEARCH_MAX_FILE_BYTES) continue

    let text: string
    try {
      text = await fs.readFile(absPath, 'utf8')
    } catch {
      continue
    }

    const lines = text.split('\n')
    const matchedLineIndices = new Set<number>()
    let matchesInFile = 0

    for (let i = 0; i < lines.length; i++) {
      // Hard cap matches to bound output even on pathological patterns.
      if (matchesInFile >= CUSTOM_SEARCH_MAX_MATCHES_PER_FILE) break
      // Bound regex work per line to defend against ReDoS on long lines.
      const line = lines[i]!
      const lineForTest = line.length > 2000 ? line.slice(0, 2000) : line
      if (regex.test(lineForTest)) {
        matchesInFile++
        const start = Math.max(0, i - CUSTOM_SEARCH_CONTEXT_LINES)
        const end = Math.min(lines.length - 1, i + CUSTOM_SEARCH_CONTEXT_LINES)
        for (let j = start; j <= end; j++) matchedLineIndices.add(j)
      }
    }

    if (matchedLineIndices.size === 0) continue

    // Group contiguous matched lines into ranges.
    const sortedIndices = [...matchedLineIndices].toSorted((a, b) => a - b)
    const ranges: { start: number; end: number }[] = []
    let current: { start: number; end: number } | null = null
    for (const idx of sortedIndices) {
      if (!current) current = { start: idx, end: idx }
      else if (idx === current.end + 1) current.end = idx
      else {
        ranges.push(current)
        current = { start: idx, end: idx }
      }
    }
    if (current) ranges.push(current)

    if (uniqueFiles.size >= maxFiles && !uniqueFiles.has(file)) continue
    uniqueFiles.add(file)

    for (let rIdx = 0; rIdx < ranges.length; rIdx++) {
      const range = ranges[rIdx]!
      if (budgetedResults.length >= maxSymbols) break scan
      if (charsCount >= maxChars) break scan

      const sliced = lines.slice(range.start, range.end + 1).join('\n')
      const candidate: LLMCandidate = {
        file,
        symbol: `Match@L${range.start + 1}`,
        confidence: 1.0,
        tier: 'mustRead',
      }
      budgetedResults.push({
        candidate,
        code: sliced,
        signature: `File: ${file} (L${range.start + 1}-${range.end + 1})`,
        doc: `Matches pattern "${pattern}"`,
        imports: [],
        importedBy: [],
        extractionOk: true,
        startLine: range.start + 1,
        endLine: range.end + 1,
        relevanceTier: 'mustRead',
      })
      charsCount += sliced.length
    }
  }

  const map = await readMap(targetRoot).catch(() => ({
    generatedAt: Date.now(),
    parserMode: getParserMode(),
    symbolsCount: 0,
    symbols: [],
  }) as ProjectMap)
  const gitStatusMap = await getGitStatusMap(targetRoot)
  const mainMarkdown = formatFound(budgetedResults, gitStatusMap)

  const hints: string[] = []
  if (skipped > 0) hints.push(`Skipped ${skipped} paths outside workspace root.`)
  if (scanned >= CUSTOM_SEARCH_MAX_FILES_SCAN) {
    hints.push(`Scan capped at ${CUSTOM_SEARCH_MAX_FILES_SCAN} files; narrow the glob for completeness.`)
  }

  return toStructuredJSON(
    mainMarkdown,
    budgetedResults,
    budgetedResults.length > 0 ? 1.0 : 0,
    `Keyword/regex search matching "${pattern}" in "${globPattern}"`,
    hints,
    [],
    map,
  )
}
