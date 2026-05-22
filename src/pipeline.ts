import * as path from 'node:path'
import * as fs from 'node:fs/promises'

import { isCacheStale, l1Cache, l1Key } from './cache.js'
import { getMapFilePath } from './config.js'
import { extractWithOxc } from './extract.js'
import { filterMap, getDeterministicMatches } from './filter.js'
import {
  formatDegraded,
  formatFound,
  formatNotFound,
  serializeForLLM,
  toStructuredJSON,
} from './format.js'
import { getGitStatusMap, getGitHint } from './git.js'
import { askCheapLLM } from './llm.js'
import { findDeps } from './deps.js'
import { buildMap, getProjectFiles } from './parser.js'
import { l2Get, l2Set } from './l2cache.js'

import type {
  ExtractedSymbol,
  LLMCandidate,
  ProjectMap,
  ScoutConfig,
  SymbolEntry,
  ContextBudgetOptions,
  RelevanceTier,
} from './types.js'

const MAX_CHUNKS = 5

// Custom search limits — keep custom regex search bounded to prevent ReDoS / DoS.
const CUSTOM_SEARCH_MAX_PATTERN_LEN = 200
const CUSTOM_SEARCH_MAX_FILE_BYTES = 1_000_000
const CUSTOM_SEARCH_MAX_FILES_SCAN = 500
const CUSTOM_SEARCH_MAX_MATCHES_PER_FILE = 20
const CUSTOM_SEARCH_CONTEXT_LINES = 2

// Trigger pattern for explicit keyword/regex search syntax: "<pattern>" in <glob>
// Strict form: starts with `"`, has paired `" in `, ends with non-empty glob.
const CUSTOM_QUERY_REGEX = /^"([^"]{1,200})"\s+in\s+(\S[^"]{0,200})$/

interface CustomQuery {
  readonly pattern: string
  readonly globPattern: string
}

export function parseCustomQuery(task: string): CustomQuery | null {
  const match = task.trim().match(CUSTOM_QUERY_REGEX)
  if (!match) return null
  const pattern = match[1]!.trim()
  const globPattern = match[2]!.trim()
  if (!pattern || !globPattern) return null
  if (pattern.length > CUSTOM_SEARCH_MAX_PATTERN_LEN) return null
  // Reject path traversal / absolute globs up-front so Bun.Glob never scans outside the workspace.
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

const BINARY_EXTS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.mp3', '.mp4', '.mov', '.wav', '.ogg', '.webm',
  '.so', '.dll', '.dylib', '.exe', '.bin', '.wasm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
])

function looksBinary(file: string): boolean {
  return BINARY_EXTS.has(path.extname(file).toLowerCase())
}

/** Runs a literal/regex keyword search across files matching `globPattern`, capped by budget. */
async function runCustomSearch(
  query: CustomQuery,
  targetRoot: string,
  budget: ContextBudgetOptions,
): Promise<string> {
  const { pattern, globPattern } = query
  const regex = compileSearchRegex(pattern)

  const maxFiles = budget.maxFiles ?? 5
  const maxSymbols = budget.maxSymbols ?? 10
  const maxChars = budget.maxChars ?? 20000

  const glob = new Bun.Glob(globPattern)
  const budgetedResults: ExtractedSymbol[] = []
  const uniqueFiles = new Set<string>()
  let charsCount = 0
  let scanned = 0
  let skipped = 0

  scan: for await (const file of glob.scan({ cwd: targetRoot, onlyFiles: true })) {
    if (scanned >= CUSTOM_SEARCH_MAX_FILES_SCAN) break

    // Skip anything outside the workspace root and well-known noise dirs.
    if (!isInsideRoot(targetRoot, file)) {
      skipped++
      continue
    }
    if (
      file.includes('node_modules/') ||
      file.startsWith('.git/') ||
      file.includes('/.git/') ||
      file.includes('.scout-cache/') ||
      file.includes('dist/') ||
      file.includes('build/')
    ) {
      continue
    }
    if (looksBinary(file)) continue

    scanned++

    const absPath = path.resolve(targetRoot, file)
    const fileObj = Bun.file(absPath)
    const size = fileObj.size
    if (size === 0 || size > CUSTOM_SEARCH_MAX_FILE_BYTES) continue

    let text: string
    try {
      text = await fileObj.text()
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

async function readMap(targetRoot: string): Promise<ProjectMap> {
  const mapPath = getMapFilePath(targetRoot)
  try {
    const file = Bun.file(mapPath)
    if (await file.exists()) {
      const data = (await file.json()) as ProjectMap
      if (data && Array.isArray(data.files) && data.files.length > 0) {
        return data
      }
    }
  } catch {}
  return await buildMap(targetRoot)
}

async function lookupCached(
  candidate: LLMCandidate,
  summaryOnly: boolean,
  targetRoot: string,
): Promise<ExtractedSymbol | null> {
  const key = l1Key(candidate.file, candidate.symbol, summaryOnly)
  const inMemory = l1Cache.get(key)
  if (inMemory) return inMemory

  const onDisk = await l2Get(candidate.file, candidate.symbol, summaryOnly, targetRoot)
  if (onDisk) {
    l1Cache.set(key, onDisk)
    return onDisk
  }
  return null
}

async function storeCached(
  value: ExtractedSymbol,
  summaryOnly: boolean,
  targetRoot: string,
): Promise<void> {
  const { file, symbol } = value.candidate
  l1Cache.set(l1Key(file, symbol, summaryOnly), value)
  await l2Set(file, symbol, summaryOnly, value, targetRoot)
}

/** Composes a bucketed set of symbols for the cheap LLM to consume. */
function chunkSymbols(symbols: readonly SymbolEntry[], chunkCount: number): SymbolEntry[][] {
  const buckets: SymbolEntry[][] = Array.from({ length: chunkCount }, () => [])
  symbols.forEach((sym, idx) => {
    buckets[idx % chunkCount]!.push(sym)
  })
  return buckets.filter((bucket) => bucket.length > 0)
}

/** Runs the full find_code pipeline and returns unified structured JSON containing human-markdown. */
export async function runFindCodePipeline(
  task: string,
  config: ScoutConfig,
  summaryOnly = false,
  targetRoot = process.cwd(),
  budget: ContextBudgetOptions = {},
): Promise<string> {
  // Custom keyword/regex search syntax: `"<pattern>" in <glob>`
  const customQuery = parseCustomQuery(task)
  if (customQuery) {
    return runCustomSearch(customQuery, targetRoot, budget)
  }

  if (await isCacheStale(targetRoot)) {
    await buildMap(targetRoot)
  }

  const map = await readMap(targetRoot)
  if (map.symbols.length === 0) {
    const markdown = formatNotFound(task, 0)
    return toStructuredJSON(markdown, [], 0, 'Project map is empty.', [], [], map)
  }

  const maxFiles = budget.maxFiles ?? 5
  const maxSymbols = budget.maxSymbols ?? 10
  const maxChars = budget.maxChars ?? 20000
  const includeTests = budget.includeTests === true

  // 1. Deterministic Preflight Matcher
  const deterministicCandidates = getDeterministicMatches(map, task, includeTests)
  let candidates: LLMCandidate[] | null = null
  let isDeterministic = false

  if (deterministicCandidates.length > 0 && deterministicCandidates[0]!.confidence >= 0.95) {
    // Highly confident deterministic matches found, skip LLM entirely
    candidates = deterministicCandidates
    isDeterministic = true
    console.error(`[Scout] Skipped cheap LLM (Deterministic Match Confidence: ${deterministicCandidates[0]!.confidence})`)
  } else {
    // 2. Fall back to Cheap LLM Scorer
    const filtered = filterMap(map, task)
    const chunkCount = Math.max(1, Math.min(config.llmParallelism, MAX_CHUNKS))
    const chunks = chunkSymbols(filtered, chunkCount)

    const [compactMaps, gitHint] = await Promise.all([
      Promise.resolve(chunks.map(serializeForLLM)),
      getGitHint(targetRoot),
    ])

    candidates = await askCheapLLM(task, compactMaps, gitHint, config)

    // 3. Graceful degradation: If LLM is dead/timed out, fall back to deterministic matches
    if (!candidates) {
      console.error('[Scout] Cheap LLM degraded. Falling back to deterministic matches.')
      candidates = deterministicCandidates.filter((c) => c.confidence >= 0.5)
    }
  }

  // Filter candidates against known symbols in map
  const knownSymbols = new Set(map.symbols.map((s) => `${s.file}\0${s.name}`))
  let validatedCandidates = candidates.filter((c) => knownSymbols.has(`${c.file}\0${c.symbol}`))

  if (validatedCandidates.length === 0) {
    const markdown = formatNotFound(task, map.symbolsCount)
    return toStructuredJSON(markdown, [], 0, 'No matching symbols found.', [], [], map)
  }

  // Sort validated candidates by confidence descending
  validatedCandidates = validatedCandidates.toSorted((a, b) => b.confidence - a.confidence)

  // 4. Rank only directly matched symbols. We keep dependency/caller context compact
  // in metadata instead of expanding extra fallback snippets into the main payload.
  const finalCandidatesMap = new Map<string, { candidate: LLMCandidate; tier: RelevanceTier }>()

  for (const c of validatedCandidates) {
    const tier: RelevanceTier = c.tier || (c.confidence >= 0.7 ? 'mustRead' : 'likelyRelevant')
    if (tier === 'excluded') {
      console.error(`[Scout] Pruning excluded candidate: ${c.file}::${c.symbol}`)
      continue
    }
    finalCandidatesMap.set(`${c.file}::${c.symbol}`, { candidate: c, tier })
  }

  // 5. Context Budget Enforcer
  let sortedList = [...finalCandidatesMap.values()].toSorted((a, b) => {
    const tierScore = { mustRead: 4, likelyRelevant: 3, dependencyOnly: 2, testsOrExamples: 1, excluded: 0 }
    const scoreA = tierScore[a.tier]
    const scoreB = tierScore[b.tier]
    if (scoreA !== scoreB) return scoreB - scoreA
    return b.candidate.confidence - a.candidate.confidence
  })

  // Exclude test files if requested
  const testSuffixes = ['.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx', '.test.js', '.spec.js']
  if (!includeTests) {
    sortedList = sortedList.filter(
      (item) => !testSuffixes.some((sfx) => item.candidate.file.endsWith(sfx)),
    )
  } else {
    // Reclassify test files in list to testsOrExamples tier
    sortedList = sortedList.map((item) => {
      if (testSuffixes.some((sfx) => item.candidate.file.endsWith(sfx))) {
        return { ...item, tier: 'testsOrExamples' }
      }
      return item
    })
  }

  // Enforce budget limits
  const budgetedResults: ExtractedSymbol[] = []
  let omittedCount = 0
  let charsBudgetCount = 0
  const uniqueFilesCount = new Set<string>()

  for (const item of sortedList) {
    const candidate = item.candidate

    // Check if we hit budget limits
    const wouldExceedFiles = uniqueFilesCount.size >= maxFiles && !uniqueFilesCount.has(candidate.file)
    const wouldExceedSymbols = budgetedResults.length >= maxSymbols
    const wouldExceedChars = charsBudgetCount >= maxChars

    if (wouldExceedFiles || wouldExceedSymbols || wouldExceedChars) {
      omittedCount++
      continue
    }

    // Determine dynamic summaryOnly for this candidate
    let symbolSummaryOnly = summaryOnly
    if (!summaryOnly) {
      if (item.tier === 'dependencyOnly') {
        symbolSummaryOnly = true
      }
    }

    // Lookup Cache & Extract
    const cached = await lookupCached(candidate, symbolSummaryOnly, targetRoot)
    let extracted: ExtractedSymbol

    if (cached) {
      extracted = { ...cached }
    } else {
      extracted = await extractWithOxc(candidate, map, symbolSummaryOnly, targetRoot)
      const graphImporters = await findDeps(candidate.symbol, candidate.file, map)
      extracted.importedBy = graphImporters
      await storeCached(extracted, symbolSummaryOnly, targetRoot)
    }

    extracted.relevanceTier = item.tier
    budgetedResults.push(extracted)

    uniqueFilesCount.add(candidate.file)
    charsBudgetCount += extracted.code.length
  }

  const gitStatusMap = await getGitStatusMap(targetRoot)
  const mainMarkdown = formatFound(budgetedResults, gitStatusMap)

  const reason = isDeterministic
    ? 'Identified via high-confidence deterministic naming preflight.'
    : 'Identified via LLM-assisted context extraction.'

  const missingContextHints = omittedCount > 0
    ? [`Omitted ${omittedCount} lower-priority symbols because of context budget limits.`]
    : []

  const followUpQueries = budgetedResults
    .filter((r) => r.relevanceTier === 'mustRead')
    .map((r) => `trace_symbol: ${r.candidate.symbol}`)

  return toStructuredJSON(
    mainMarkdown,
    budgetedResults,
    budgetedResults.length > 0 ? budgetedResults[0]!.candidate.confidence : 1.0,
    reason,
    missingContextHints,
    followUpQueries,
    map,
  )
}

/** Traces callers, re-exports, and dependencies of a symbol. */
export async function runTraceSymbolPipeline(
  symbolName: string,
  file?: string,
  targetRoot = process.cwd(),
): Promise<string> {
  const map = await readMap(targetRoot)

  let resolvedFile = file
  if (!resolvedFile) {
    const matching = map.symbols.find((s) => s.name === symbolName)
    if (!matching) {
      const markdown = `[Scout] Symbol "${symbolName}" not found in project map.`
      return toStructuredJSON(markdown, [], 0, 'Symbol not found.', [], [], map)
    }
    resolvedFile = matching.file
  }

  const candidate: LLMCandidate = {
    file: resolvedFile,
    symbol: symbolName,
    confidence: 1.0,
  }

  const extracted = await extractWithOxc(candidate, map, false, targetRoot)
  const callers = await findDeps(symbolName, resolvedFile, map)
  extracted.importedBy = callers
  extracted.relevanceTier = 'mustRead'

  const dependentSymbols: ExtractedSymbol[] = []

  // Trace dependency imports inside this file
  const fileMeta = map.files?.find((f) => f.file === resolvedFile)
  if (fileMeta) {
    for (const imp of fileMeta.imports) {
      if (imp.resolved) {
        for (const spec of imp.specifiers) {
          const symExists = map.symbols.some((s) => s.file === imp.resolved && s.name === spec.imported)
          if (symExists) {
            const depCandidate: LLMCandidate = {
              file: imp.resolved,
              symbol: spec.imported,
              confidence: 0.8,
            }
            const depExtracted = await extractWithOxc(depCandidate, map, true, targetRoot)
            depExtracted.relevanceTier = 'dependencyOnly'
            dependentSymbols.push(depExtracted)
          }
        }
      }
    }
  }

  const gitStatusMap = await getGitStatusMap(targetRoot)
  const allResults = [extracted, ...dependentSymbols]
  const markdown = formatFound(allResults, gitStatusMap)

  return toStructuredJSON(
    markdown,
    allResults,
    1.0,
    `Traced definition and caller/dependency graph for symbol: ${symbolName}`,
    [],
    callers.map((c) => `trace_symbol: ${symbolName} in ${c}`),
    map,
  )
}

/** Securely reads context of a specific file range. */
export async function runGetFileContext(
  fileRelPath: string,
  startLine?: number,
  endLine?: number,
  targetRoot = process.cwd(),
): Promise<string> {
  const map = await readMap(targetRoot).catch(() => undefined)
  const rootRealPath = await fs.realpath(targetRoot).catch(() => path.resolve(targetRoot))
  const absPath = path.resolve(rootRealPath, fileRelPath)
  const relativePath = path.relative(rootRealPath, absPath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    const errorMsg = `[Scout] Access denied: file is outside of the workspace root: ${fileRelPath}`
    return toStructuredJSON(errorMsg, [], 0, 'Access denied.', [], [], map)
  }

  const fileObj = Bun.file(absPath)
  if (!(await fileObj.exists())) {
    const errorMsg = `[Scout] File not found: ${fileRelPath}`
    return toStructuredJSON(errorMsg, [], 0, 'File not found.', [], [], map)
  }

  const fileRealPath = await fs.realpath(absPath)
  const realRelativePath = path.relative(rootRealPath, fileRealPath)
  if (realRelativePath.startsWith('..') || path.isAbsolute(realRelativePath)) {
    const errorMsg = `[Scout] Access denied: file resolves outside of the workspace root: ${fileRelPath}`
    return toStructuredJSON(errorMsg, [], 0, 'Access denied.', [], [], map)
  }

  const text = await Bun.file(fileRealPath).text()
  const lines = text.split('\n')
  const sLine = startLine ? Math.max(1, startLine) : 1
  const eLine = endLine ? Math.min(lines.length, endLine) : lines.length

  const slicedContent = lines.slice(sLine - 1, eLine).join('\n')
  const markdown = [
    `## File Context: ${fileRelPath} (L${sLine}-${eLine})`,
    `\`\`\`ts\n${slicedContent}\n\`\`\``,
  ].join('\n')

  const mockCandidate: LLMCandidate = { file: fileRelPath, symbol: 'FILE_CONTEXT', confidence: 1.0 }
  const mockExtracted: ExtractedSymbol = {
    candidate: mockCandidate,
    code: slicedContent,
    signature: '',
    doc: '',
    imports: [],
    importedBy: [],
    extractionOk: true,
    startLine: sLine,
    endLine: eLine,
    relevanceTier: 'mustRead',
  }

  return toStructuredJSON(
    markdown,
    [mockExtracted],
    1.0,
    `Extracted line range context for file: ${fileRelPath}`,
    [],
    [],
    map,
  )
}

/** Searches files by pattern inside the workspace. */
export async function runFindFiles(pattern: string, targetRoot = process.cwd()): Promise<string> {
  const files = await getProjectFiles(targetRoot)

  // Convert simple wildcard format to RegExp
  // E.g. *controller* -> .*controller.*
  const cleanPat = pattern.replace(/\*/g, '.*')
  const regex = new RegExp(`^${cleanPat}$`, 'i')

  const matches = files.filter((f) => regex.test(f) || f.toLowerCase().includes(pattern.toLowerCase()))

  const markdown = [
    `### Found ${matches.length} files matching: "${pattern}"`,
    ...matches.map((m) => `- ${m}`),
  ].join('\n')

  const results = matches.map((m) => {
    const candidate: LLMCandidate = { file: m, symbol: 'FILE_MATCH', confidence: 1.0 }
    return {
      candidate,
      code: '',
      signature: '',
      doc: '',
      imports: [],
      importedBy: [],
      extractionOk: true,
      relevanceTier: 'mustRead' as const,
    }
  })

  return toStructuredJSON(
    markdown,
    results,
    1.0,
    `Discovered ${matches.length} files matching pattern.`,
    [],
    [],
  )
}

/** Generates a high-level summary outline pack for planning. */
export async function runExplainContextPack(
  task: string,
  config: ScoutConfig,
  targetRoot = process.cwd(),
): Promise<string> {
  // We run runFindCodePipeline with summaryOnly = true to collapse bodies
  return runFindCodePipeline(task, config, true, targetRoot, { maxFiles: 10, maxSymbols: 20 })
}
