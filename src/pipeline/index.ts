import * as path from 'node:path'
import * as fs from 'node:fs/promises'

import { isCacheStale } from '../cache/l1.js'
import { extractWithOxc } from '../extraction/extract.js'
import { filterMap, getDeterministicMatches, extractCodeIdentifiers } from '../extraction/matcher/filter.js'
import {
  formatFound,
  formatNotFound,
  serializeForLLM,
  toStructuredJSON,
} from '../bundle/formatter/format.js'
import { getGitStatusMap, getGitHint, getFileWorktreeStatuses } from '../shared/utils/git.js'
import { askCheapLLM } from '../extraction/llm.js'
import { findDeps } from '../dependency-resolver/deps.js'
import { buildMap } from '../indexing/symbol-map/build-map.js'
import { isTestFile } from '../shared/constants/test-suffixes.js'
import { TIER_SCORE } from '../shared/constants/tier-scores.js'
import { resolveBudget } from '../shared/constants/budget.js'
import { parseCustomQuery, runCustomSearch } from '../extraction/custom-search/searcher.js'
import { analyzeQuery } from '../extraction/query-analyzer.js'
import { validateExtractedSymbols } from '../extraction/content-validator.js'
import { readMap, lookupCached, storeCached, chunkSymbols } from '../cache/map-cache.js'
import { resolveSecurePath } from './resolve-path.js'
import { filesystemSymbolSearch } from './fs-search.js'

import type {
  ExtractedSymbol,
  LLMCandidate,
  ProjectMap,
  QueryAnalysis,
  ScoutConfig,
  ContextBudgetOptions,
  RelevanceTier,
} from '../shared/types/index.js'

const MAX_CHUNKS = 5
const FILE_CONTEXT_SYMBOL = 'FILE_CONTEXT'

/** Runs the full find_code pipeline and returns unified structured JSON containing human-markdown. */
export async function runFindCodePipeline(
  task: string,
  config: ScoutConfig,
  summaryOnly = false,
  targetRoot = process.cwd(),
  budget: ContextBudgetOptions = {},
): Promise<string> {
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

  const resolvedBudget = resolveBudget(budget)
  const { maxFiles, maxSymbols, maxChars, includeTests } = resolvedBudget

  // Step 1: Analyze query to understand intent and extract search terms
  const analysis = await analyzeQuery(task, config)
  if (analysis) {
    console.error(
      `[Scout] Query analysis: intent=${analysis.intent}, symbols=[${analysis.symbolNames.join(',')}], terms=[${analysis.expandedTerms.slice(0, 5).join(',')}]`,
    )
  }

  // Step 2: Deterministic matching (enhanced with analysis)
  const deterministicCandidates = getDeterministicMatches(map, task, includeTests, analysis)
  const firstCandidate = deterministicCandidates[0]
  const deterministicConfidence = firstCandidate?.confidence ?? 0
  const hasHighConfidenceMatch = deterministicConfidence >= 0.95

  let candidates: LLMCandidate[]
  let isDeterministic: boolean

  if (hasHighConfidenceMatch) {
    candidates = deterministicCandidates
    isDeterministic = true
    console.error(`[Scout] Skipped cheap LLM (Deterministic Match Confidence: ${deterministicConfidence})`)
  } else {
    // Step 3: LLM-assisted matching (enhanced with analysis context)
    const filtered = filterMap(map, task, analysis)
    const chunkCount = Math.max(1, Math.min(config.llmParallelism, MAX_CHUNKS))
    const chunks = chunkSymbols(filtered, chunkCount)

    const [compactMaps, gitHint] = await Promise.all([
      Promise.resolve(chunks.map(serializeForLLM)),
      getGitHint(targetRoot),
    ])

    const llmResult = await askCheapLLM(task, compactMaps, gitHint, config, analysis)

    if (llmResult) {
      candidates = llmResult
      isDeterministic = false
    } else {
      console.error('[Scout] Cheap LLM degraded. Falling back to deterministic matches.')
      candidates = deterministicCandidates.filter((c) => c.confidence >= 0.5)
      isDeterministic = false
    }
  }

  const knownSymbols = new Set(map.symbols.map((s) => `${s.file}\0${s.name}`))
  const validatedCandidates = candidates
    .filter((c) => knownSymbols.has(`${c.file}\0${c.symbol}`))
    .toSorted((a, b) => b.confidence - a.confidence)

  // Filesystem fallback: trigger when no candidates found OR when best candidate
  // has very low relevance (LLM returned irrelevant files).
  const bestConfidence = validatedCandidates[0]?.confidence ?? 0
  const needsFallback = validatedCandidates.length === 0 || bestConfidence < 0.5

  if (needsFallback) {
    const fallbackResult = await tryFilesystemFallback(task, analysis, targetRoot, {
      summaryOnly, includeTests, maxFiles, maxSymbols, maxChars,
    })
    if (fallbackResult) return fallbackResult
  }

  // Only return NOT_FOUND if there were truly no candidates at all
  if (validatedCandidates.length === 0) {
    const markdown = formatNotFound(task, map.symbolsCount)
    return toStructuredJSON(markdown, [], 0, 'No matching symbols found.', [], [], map)
  }

  const rankedCandidates = new Map<string, { candidate: LLMCandidate; tier: RelevanceTier }>()
  for (const c of validatedCandidates) {
    const tier: RelevanceTier = c.tier ?? (c.confidence >= 0.7 ? 'mustRead' : 'likelyRelevant')
    if (tier === 'excluded') {
      console.error(`[Scout] Pruning excluded candidate: ${c.file}::${c.symbol}`)
      continue
    }
    rankedCandidates.set(`${c.file}::${c.symbol}`, { candidate: c, tier })
  }

  const byTierThenConfidence = (
    a: { candidate: LLMCandidate; tier: RelevanceTier },
    b: { candidate: LLMCandidate; tier: RelevanceTier },
  ): number => {
    const scoreDiff = TIER_SCORE[b.tier] - TIER_SCORE[a.tier]
    return scoreDiff !== 0 ? scoreDiff : b.candidate.confidence - a.candidate.confidence
  }

  let rankedList = [...rankedCandidates.values()].toSorted(byTierThenConfidence)

  if (!includeTests) {
    rankedList = rankedList.filter((item) => !isTestFile(item.candidate.file))
  } else {
    rankedList = rankedList.map((item) =>
      isTestFile(item.candidate.file) ? { ...item, tier: 'testsOrExamples' as RelevanceTier } : item,
    )
  }

  const budgetedResults = await applyBudget(rankedList, summaryOnly, map, targetRoot, maxFiles, maxSymbols, maxChars)

  // Step 4: Validate extracted content against query to filter false positives.
  // Skip for deterministic high-confidence matches — the symbol name IS in the project map,
  // so content is guaranteed correct; running validation would waste an LLM call.
  const validatedSymbols =
    isDeterministic && deterministicConfidence >= 0.95
      ? budgetedResults.symbols
      : await validateExtractedSymbols(budgetedResults.symbols, task, analysis, config)

  const gitStatusMap = await getGitStatusMap(targetRoot)
  const mainMarkdown = formatFound(validatedSymbols, gitStatusMap)

  // Check for stale index (files changed since last build)
  const resultFiles = [...new Set(validatedSymbols.map((s) => s.candidate.file))]
  const worktreeStatuses = await getFileWorktreeStatuses(resultFiles, targetRoot, map.generatedAt)
  const hasStaleIndex = worktreeStatuses.some((s) => !s.indexFresh)

  const reason = isDeterministic
    ? 'Identified via high-confidence deterministic naming preflight.'
    : 'Identified via LLM-assisted context extraction.'

  const missingContextHints = budgetedResults.omittedCount > 0
    ? [`Omitted ${budgetedResults.omittedCount} lower-priority symbols because of context budget limits.`]
    : []

  if (hasStaleIndex) {
    missingContextHints.push('Some files have changed since the last index build. Results may be incomplete.')
  }

  const followUpQueries = validatedSymbols
    .filter((r) => r.relevanceTier === 'mustRead')
    .map((r) => `trace_symbol: ${r.candidate.symbol}`)

  return toStructuredJSON(
    mainMarkdown,
    validatedSymbols,
    validatedSymbols[0]?.candidate.confidence ?? 1.0,
    reason,
    missingContextHints,
    followUpQueries,
    map,
    undefined,
    hasStaleIndex,
  )
}

interface BudgetResult {
  readonly symbols: ExtractedSymbol[]
  readonly omittedCount: number
}

/**
 * Enforces file/symbol/char budget against a pre-ranked list.
 * Extractions are serial because each result contributes to the rolling char count.
 */
async function applyBudget(
  rankedList: ReadonlyArray<{ candidate: LLMCandidate; tier: RelevanceTier }>,
  summaryOnly: boolean,
  map: ProjectMap,
  targetRoot: string,
  maxFiles: number,
  maxSymbols: number,
  maxChars: number,
): Promise<BudgetResult> {
  const symbols: ExtractedSymbol[] = []
  let omittedCount = 0
  let charsUsed = 0
  const seenFiles = new Set<string>()

  for (const item of rankedList) {
    const { candidate, tier } = item

    const wouldExceedFiles = seenFiles.size >= maxFiles && !seenFiles.has(candidate.file)
    const wouldExceedSymbols = symbols.length >= maxSymbols
    const wouldExceedChars = charsUsed >= maxChars

    if (wouldExceedFiles || wouldExceedSymbols || wouldExceedChars) {
      omittedCount++
      continue
    }

    const effectiveSummaryOnly = summaryOnly || tier === 'dependencyOnly'

    const cached = await lookupCached(candidate, effectiveSummaryOnly, targetRoot)
    let extracted: ExtractedSymbol

    if (cached) {
      extracted = { ...cached }
    } else {
      extracted = await extractWithOxc(candidate, map, effectiveSummaryOnly, targetRoot)
      const graphImporters = await findDeps(candidate.symbol, candidate.file, map)
      extracted.importedBy = graphImporters
      await storeCached(extracted, effectiveSummaryOnly, targetRoot)
    }

    extracted.relevanceTier = tier
    symbols.push(extracted)
    seenFiles.add(candidate.file)
    charsUsed += extracted.code.length
  }

  return { symbols, omittedCount }
}

/** Traces callers, re-exports, and dependencies of a symbol. */
export async function runTraceSymbolPipeline(
  symbolName: string,
  file?: string,
  targetRoot = process.cwd(),
): Promise<string> {
  const map = await readMap(targetRoot)

  const resolvedFile = file ?? map.symbols.find((s) => s.name === symbolName)?.file
  if (!resolvedFile) {
    const markdown = `[Scout] Symbol "${symbolName}" not found in project map.`
    return toStructuredJSON(markdown, [], 0, 'Symbol not found.', [], [], map)
  }

  const candidate: LLMCandidate = { file: resolvedFile, symbol: symbolName, confidence: 1.0 }
  const extracted = await extractWithOxc(candidate, map, false, targetRoot)
  const callers = await findDeps(symbolName, resolvedFile, map)
  extracted.importedBy = callers
  extracted.relevanceTier = 'mustRead'

  const fileMeta = map.files?.find((f) => f.file === resolvedFile)
  const depCandidates: LLMCandidate[] = fileMeta
    ? fileMeta.imports.flatMap((imp) => {
        if (!imp.resolved) return []
        return imp.specifiers
          .filter((spec) => map.symbols.some((s) => s.file === imp.resolved && s.name === spec.imported))
          .map((spec) => ({ file: imp.resolved!, symbol: spec.imported, confidence: 0.8 }))
      })
    : []

  const dependentSymbols = await Promise.all(
    depCandidates.map(async (depCandidate) => {
      const depExtracted = await extractWithOxc(depCandidate, map, true, targetRoot)
      depExtracted.relevanceTier = 'dependencyOnly'
      return depExtracted
    }),
  )

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

/** Securely reads context of a specific file range with auto-expanded imports and related types. */
export async function runGetFileContext(
  fileRelPath: string,
  startLine?: number,
  endLine?: number,
  targetRoot = process.cwd(),
  _query?: string,
): Promise<string> {
  const map = await readMap(targetRoot).catch(() => undefined)
  const resolved = await resolveSecurePath(fileRelPath, targetRoot)

  if ('error' in resolved) {
    return toStructuredJSON(resolved.error, [], 0, 'Access denied or file not found.', [], [], map)
  }

  const text = await fs.readFile(resolved.realPath, 'utf8')
  const lines = text.split('\n')
  const sLine = startLine ? Math.max(1, startLine) : 1
  const eLine = endLine ? Math.min(lines.length, endLine) : lines.length

  const slicedContent = lines.slice(sLine - 1, eLine).join('\n')

  const sections: string[] = []
  const ext = fileRelPath.split('.').pop() || 'text'

  // Include imports when the slice starts after them and they are short enough (max 30 lines).
  const importsEnd = sLine > 1 ? findImportsEnd(lines) : 0
  if (importsEnd > 0 && importsEnd < sLine && importsEnd <= 30) {
    const importsSection = lines.slice(0, importsEnd).join('\n')
    sections.push(`### Imports (L1-${importsEnd})`)
    sections.push(`\`\`\`${ext}`)
    sections.push(importsSection)
    sections.push('```')
    sections.push('')
  }

  sections.push(`### File Context: ${fileRelPath} (L${sLine}-${eLine})`)
  sections.push(`\`\`\`${ext}`)
  sections.push(slicedContent)
  sections.push('```')

  // Include related types referenced in the code (max 2, max 10 lines each).
  if (!map) {
    const markdown = sections.join('\n')
    return toStructuredJSON(markdown, [makeFileContextExtracted(fileRelPath, slicedContent, sLine, eLine, map)], 1.0, 'Direct file context provided.', [], [], map)
  }

  const relatedTypes = findRelatedTypesInCode(slicedContent, map, fileRelPath)
  for (const typeSym of relatedTypes.slice(0, 2)) {
    const typeSlice = await readTypeSlice(targetRoot, typeSym)
    if (typeSlice) {
      sections.push('')
      sections.push(`#### ${typeSym.name} (${typeSym.file}:${typeSym.line})`)
      sections.push(`\`\`\`${ext}`)
      sections.push(typeSlice)
      sections.push('```')
    }
  }

  const markdown = sections.join('\n')
  return toStructuredJSON(markdown, [makeFileContextExtracted(fileRelPath, slicedContent, sLine, eLine, map)], 1.0, 'Direct file context provided with imports and related types.', [], [], map)
}

/**
 * Finds the end line of the imports section in a file.
 * Returns 0 if no imports section is found.
 */
function findImportsEnd(lines: string[]): number {
  let lastImportLine = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    // Match import statements
    if (line.startsWith('import ') || line.startsWith('import{') || line.startsWith('import type ')) {
      lastImportLine = i + 1
    }
    // Stop searching after a non-import, non-empty, non-comment line
    // that comes after at least one import
    if (lastImportLine > 0 && line && !line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*') && !line.startsWith('import ')) {
      break
    }
  }
  return lastImportLine
}

function makeFileContextExtracted(
  file: string,
  code: string,
  startLine: number,
  endLine: number,
  map: ProjectMap | undefined,
): ExtractedSymbol {
  return {
    candidate: { file, symbol: FILE_CONTEXT_SYMBOL, confidence: 1.0 },
    code,
    signature: '',
    doc: '',
    imports: map?.files?.find((f) => f.file === file)?.imports.map((i) => i.source) ?? [],
    importedBy: [],
    extractionOk: true,
    startLine,
    endLine,
    relevanceTier: 'mustRead',
  }
}

async function readTypeSlice(
  targetRoot: string,
  typeSym: { name: string; file: string; line: number },
): Promise<string | null> {
  try {
    const typeContent = await fs.readFile(path.join(targetRoot, typeSym.file), 'utf8')
    const typeLines = typeContent.split('\n')
    const start = Math.max(0, typeSym.line - 1)
    const end = Math.min(typeLines.length, start + 10)
    return typeLines.slice(start, end).join('\n')
  } catch {
    return null
  }
}

interface FallbackBudget {
  readonly summaryOnly: boolean
  readonly includeTests: boolean
  readonly maxFiles: number
  readonly maxSymbols: number
  readonly maxChars: number
}

async function tryFilesystemFallback(
  task: string,
  analysis: QueryAnalysis | null | undefined,
  targetRoot: string,
  budget: FallbackBudget,
): Promise<string | null> {
  const exactIdentifiers = extractCodeIdentifiers(task)
  const analysisSymbols = analysis?.symbolNames ?? []
  const allSymbolNames = [...new Set([...exactIdentifiers, ...analysisSymbols])]
  if (allSymbolNames.length === 0) return null

  console.error(`[Scout] Weak matches. Trying filesystem fallback for: ${allSymbolNames.join(', ')}`)
  const fsMatches = await filesystemSymbolSearch(allSymbolNames, targetRoot)
  if (fsMatches.length === 0) return null

  console.error(`[Scout] Filesystem fallback found ${fsMatches.length} symbols. Rebuilding index...`)
  await buildMap(targetRoot)
  const freshMap = await readMap(targetRoot)

  const freshCandidates = getDeterministicMatches(freshMap, task, budget.includeTests, analysis)
  const freshValidated = freshCandidates.filter((c) => c.confidence >= 0.8)
  if (freshValidated.length === 0) return null

  console.error(`[Scout] Fresh index matched ${freshValidated.length} candidates after rebuild.`)
  const freshRanked = freshValidated.map((c) => ({
    candidate: c,
    tier: (c.confidence >= 0.95 ? 'mustRead' : 'likelyRelevant') as RelevanceTier,
  }))

  const budgetedResults = await applyBudget(freshRanked, budget.summaryOnly, freshMap, targetRoot, budget.maxFiles, budget.maxSymbols, budget.maxChars)
  const gitStatusMap = await getGitStatusMap(targetRoot)
  const mainMarkdown = formatFound(budgetedResults.symbols, gitStatusMap)

  return toStructuredJSON(
    mainMarkdown,
    budgetedResults.symbols,
    budgetedResults.symbols[0]?.candidate.confidence ?? 1.0,
    `Found via filesystem fallback and index rebuild. Symbols: ${allSymbolNames.join(', ')}`,
    [`Index was stale — symbols found on disk but not in cached map. Index has been rebuilt.`],
    budgetedResults.symbols.map((r) => `trace_symbol: ${r.candidate.symbol}`),
    freshMap,
  )
}

/**
 * Finds type definitions (interfaces/type aliases) referenced in the given code snippet.
 * Returns symbol entries for definitions found in the project map.
 */
function findRelatedTypesInCode(
  code: string,
  map: ProjectMap,
  excludeFile: string,
): readonly { name: string; file: string; line: number }[] {
  const codeWords = new Set(code.split(/[\s\W_]+/).filter((w) => w.length > 2))
  const results: { name: string; file: string; line: number }[] = []

  for (const sym of map.symbols) {
    if (results.length >= 2) break
    if (sym.file === excludeFile) continue
    if (sym.kind !== 'TSInterfaceDeclaration' && sym.kind !== 'TSTypeAliasDeclaration') continue
    if (codeWords.has(sym.name)) {
      results.push({ name: sym.name, file: sym.file, line: sym.line })
    }
  }

  return results
}

/** Generates a high-level summary outline pack for planning. */
export async function runExplainContextPack(
  task: string,
  config: ScoutConfig,
  targetRoot = process.cwd(),
): Promise<string> {
  return runFindCodePipeline(task, config, true, targetRoot, { maxFiles: 10, maxSymbols: 20 })
}
