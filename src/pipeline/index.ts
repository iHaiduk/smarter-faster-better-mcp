import * as path from 'node:path'
import * as fs from 'node:fs/promises'

import { isCacheStale } from '../cache/l1.js'
import { extractWithOxc } from '../extraction/extract.js'
import { getDeterministicMatches, extractCodeIdentifiers } from '../extraction/matcher/filter.js'
import {
  formatFound,
  formatNotFound,
  toStructuredJSON,
} from '../bundle/formatter/format.js'
import { getGitStatusMap } from '../shared/utils/git.js'
import { findDeps } from '../dependency-resolver/deps.js'
import { buildMap } from '../indexing/symbol-map/build-map.js'
import { resolveBudget } from '../shared/constants/budget.js'
import { parseCustomQuery, runCustomSearch } from '../extraction/custom-search/searcher.js'
import { analyzeQuery } from '../extraction/query-analyzer.js'
import { readMap } from '../cache/map-cache.js'
import { resolveSecurePath } from './resolve-path.js'
import { selectCoarseCandidates, jevFilterCandidates } from '../extraction/jev/dynamic-triage.js'
import { parseFile } from '../indexing/parser/oxc-walker.js'
import { loadTsConfigPaths } from '../indexing/resolver/tsconfig-paths.js'
import { STOP_WORDS } from '../shared/prompts/stop-words.js'

import type {
  CandidateEvaluation,
  ExtractedSymbol,
  FileMetadata,
  LLMCandidate,
  ProjectMap,
  ScoutConfig,
  SymbolEntry,
  ContextBudgetOptions,
  ToolResultPayload,
} from '../shared/types/index.js'

const FILE_CONTEXT_SYMBOL = 'FILE_CONTEXT'

function stemWord(word: string): string[] {
  const forms = [word]
  if (word.endsWith('ed')) {
    const stripped = word.slice(0, -2)
    forms.push(stripped, word.slice(0, -1))
    if (stripped.length >= 3 && stripped[stripped.length - 1] === stripped[stripped.length - 2]) {
      forms.push(stripped.slice(0, -1))
    }
  }
  if (word.endsWith('ing')) {
    const stripped = word.slice(0, -3)
    forms.push(stripped, stripped + 'e')
    if (stripped.length >= 3 && stripped[stripped.length - 1] === stripped[stripped.length - 2]) {
      forms.push(stripped.slice(0, -1))
    }
  }
  if (word.endsWith('er') || word.endsWith('or')) {
    const stripped = word.slice(0, -2)
    forms.push(stripped)
    if (stripped.length >= 3 && stripped[stripped.length - 1] === stripped[stripped.length - 2]) {
      forms.push(stripped.slice(0, -1))
    }
  }
  if (word.endsWith('ies')) forms.push(word.slice(0, -3) + 'y', word.slice(0, -3), 'dep', 'deps')
  if (word.endsWith('s') && !word.endsWith('ss')) forms.push(word.slice(0, -1))
  if (word === 'deps' || word === 'dependency' || word === 'dependencies') {
    forms.push('dep', 'deps', 'depend', 'dependencies')
  }
  return [...new Set(forms.filter((f) => f.length >= 3))]
}

export function extractTaskTerms(task: string): string[] {
  const codeIds = extractCodeIdentifiers(task)
  const words = task
    .toLowerCase()
    .split(/[\s\W_]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
  const stemmed = words.flatMap((w) => stemWord(w))
  return [...new Set([...codeIds, ...words, ...stemmed])]
}

function matchSymbolsInFile(
  fileSymbols: readonly SymbolEntry[],
  task: string,
  terms: readonly string[],
): SymbolEntry[] {
  const exactNames = new Set(extractCodeIdentifiers(task).map((id) => id.toLowerCase()))
  const scored = fileSymbols.map((sym) => {
    const symLower = sym.name.toLowerCase()
    let score = 0
    if (exactNames.has(symLower)) {
      score += 100
    }
    for (const term of terms) {
      const termLower = term.toLowerCase()
      if (symLower === termLower) score += 50
      else if (symLower.startsWith(termLower)) score += 35
      else if (symLower.includes(termLower) || (termLower.length >= 4 && termLower.includes(symLower))) score += 20
    }
    return { sym, score }
  })

  const matching = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.sym.line - b.sym.line)
  if (matching.length > 0) {
    return matching.slice(0, 3).map((m) => m.sym)
  }
  return []
}

export async function ensureFileFreshness(
  filePath: string,
  map: ProjectMap,
  targetRoot: string,
): Promise<boolean> {
  try {
    const absPath = path.resolve(targetRoot, filePath)
    const st = await fs.stat(absPath)
    if (st.mtimeMs > map.generatedAt) {
      const tsconfig = await loadTsConfigPaths(targetRoot)
      const parsed = await parseFile(filePath, targetRoot, 'auto', tsconfig.paths, tsconfig.baseUrl)
      const otherSymbols = map.symbols.filter((s) => s.file !== filePath)
      const otherFiles = (map.files ?? []).filter((f) => f.file !== filePath)
      ;(map as unknown as { symbols: SymbolEntry[] }).symbols = [...otherSymbols, ...parsed.symbols]
      ;(map as unknown as { files: FileMetadata[] }).files = [...otherFiles, parsed.metadata]
      return true
    }
  } catch {
    // If stat fails (e.g. file deleted), do not crash
  }
  return false
}

interface FileRenderPayload {
  readonly file: string
  readonly score: number
  readonly verdict?: string
  readonly isOutline: boolean
  readonly symbols: ExtractedSymbol[]
  readonly relatedTypes: { name: string; file: string; line: number; code: string }[]
  readonly outlineMessage?: string
}

function renderFilePayload(
  payload: FileRenderPayload,
  stage: 'full' | 'no-types' | 'folded',
): string {
  const sections: string[] = []
  const scorePercent = payload.score ? ` (score: ${(payload.score * 100).toFixed(0)}%)` : ''
  const verdictLine = payload.verdict ? `Verdict: ${payload.verdict}` : ''

  sections.push(`### ${payload.file}${scorePercent}`)
  if (verdictLine) sections.push(verdictLine)

  if (payload.isOutline) {
    sections.push(payload.outlineMessage ?? '// No symbol matched query identifiers')
    for (const s of payload.symbols) {
      const loc = s.startLine && s.endLine ? `:L${s.startLine}-${s.endLine}` : ''
      sections.push(`- ${s.signature || s.candidate.symbol} (${payload.file}${loc})`)
    }
    return sections.join('\n')
  }

  for (const sym of payload.symbols) {
    const loc = sym.startLine && sym.endLine ? `:L${sym.startLine}-${sym.endLine}` : ''
    sections.push(`#### ${sym.candidate.symbol} (${payload.file}${loc})`)

    if (stage === 'folded') {
      const lineCount = sym.startLine && sym.endLine ? sym.endLine - sym.startLine + 1 : 1
      sections.push(`\`\`\`ts\n// L${sym.startLine ?? 1}-L${sym.endLine ?? 1} [folded ${lineCount} lines]\n${sym.signature || sym.candidate.symbol}\n\`\`\``)
    } else {
      sections.push(`\`\`\`ts\n${sym.code || sym.signature}\n\`\`\``)
    }

    const metaParts: string[] = []
    if (sym.imports.length > 0) metaParts.push(`Imports: ${sym.imports.slice(0, 5).join(', ')}`)
    if (sym.importedBy.length > 0) metaParts.push(`Used by: ${sym.importedBy.slice(0, 5).join(', ')}`)
    if (metaParts.length > 0) sections.push(metaParts.join(' | '))
  }

  if (stage === 'full' && payload.relatedTypes.length > 0) {
    for (const rt of payload.relatedTypes.slice(0, 2)) {
      sections.push(`##### Related Type: ${rt.name} (${rt.file}:L${rt.line})`)
      sections.push(`\`\`\`ts\n${rt.code}\n\`\`\``)
    }
  }

  return sections.join('\n')
}

function renderWithBudgetWaterfall(
  payloads: FileRenderPayload[],
  maxChars = 12000,
  jevDegraded = false,
): { markdown: string; omittedFilesCount: number; isFolded: boolean } {
  const filesToRender = [...payloads]
  let stage: 'full' | 'no-types' | 'folded' = 'full'
  let omittedFilesCount = 0

  const getFullMarkdown = (list: FileRenderPayload[], currentStage: 'full' | 'no-types' | 'folded') => {
    return list.map((p) => renderFilePayload(p, currentStage)).join('\n\n')
  }

  let text = getFullMarkdown(filesToRender, stage)

  // Stage 1: Drop lowest-scored files until <= maxChars (keeping at least 1 file)
  while (text.length > maxChars && filesToRender.length > 1) {
    filesToRender.sort((a, b) => b.score - a.score)
    filesToRender.pop()
    omittedFilesCount++
    text = getFullMarkdown(filesToRender, stage)
  }

  // Stage 2: Drop related types if still over budget
  if (text.length > maxChars) {
    stage = 'no-types'
    text = getFullMarkdown(filesToRender, stage)
  }

  // Stage 3: Fold symbol bodies to one-line signatures if still over budget
  let isFolded = false
  if (text.length > maxChars) {
    stage = 'folded'
    isFolded = true
    text = getFullMarkdown(filesToRender, stage)
  }

  // Stage 4: Hard slice if single file is huge
  if (text.length > maxChars) {
    text = text.slice(0, maxChars - 300) + '\n... [truncated to fit budget]'
  }

  const footerParts = [
    `Scout Budget: ${text.length} chars / ${maxChars} limit`,
  ]
  if (omittedFilesCount > 0) footerParts.push(`dropped ${omittedFilesCount} file(s)`)
  if (isFolded) footerParts.push('folded bodies to signatures')
  if (jevDegraded) footerParts.push('Jev: fallback mode')

  const finalMarkdown = `[Scout: FOUND]\n\n${text}\n\n---\n[${footerParts.join(' | ')}]`
  return { markdown: finalMarkdown, omittedFilesCount, isFolded }
}

/** Runs the full find_code pipeline and returns unified structured JSON containing human-markdown. */
export async function runFindCodePipeline(
  task: string,
  config: ScoutConfig,
  summaryOnly = false,
  targetRoot = process.cwd(),
  budget: ContextBudgetOptions = {},
): Promise<ToolResultPayload> {
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
  const maxChars = resolvedBudget.maxChars || 12000

  // 1. Extract search terms & identifiers
  const terms = extractTaskTerms(task)
  const analysis = await analyzeQuery(task, config).catch(() => null)
  if (analysis?.symbolNames) {
    terms.push(...analysis.symbolNames)
  }

  // 2. Deterministic candidate check
  const deterministicCandidates = getDeterministicMatches(map, task, resolvedBudget.includeTests, analysis)
  const deterministicFiles = [...new Set(deterministicCandidates.map((c) => c.file))]

  // 3. Coarse candidate selection (up to 8 files)
  const coarseFiles = selectCoarseCandidates(map, terms, undefined, 8)
  const candidateFiles = [...new Set([...deterministicFiles, ...coarseFiles])].slice(0, 8)

  if (candidateFiles.length === 0) {
    const markdown = formatNotFound(task, map.symbolsCount)
    return toStructuredJSON(markdown, [], 0, 'No matching symbols found.', [], [], map)
  }

  // 4. Jev System-1 Filtering (keep up to 5, recall guarded: drop only on clear no with p <= 0.3)
  const jevRes = await jevFilterCandidates(map, candidateFiles, task, undefined, config, 5)
  const survivingFiles: readonly {
    file: string
    score: number
    evaluations?: CandidateEvaluation['evaluations']
  }[] =
    jevRes.kept.length > 0
      ? jevRes.kept
      : candidateFiles.slice(0, 1).map((f) => ({ file: f, score: 0.5, evaluations: undefined }))

  // 5. Freshness check for surviving files
  await Promise.all(survivingFiles.map((f) => ensureFileFreshness(f.file, map, targetRoot)))

  // 6. For each surviving file, pick symbols & extract
  const filePayloads: FileRenderPayload[] = []
  const allExtractedSymbols: ExtractedSymbol[] = []

  for (const item of survivingFiles) {
    const fileSymbols = map.symbols.filter((s) => s.file === item.file)
    const matchingSymbols = matchSymbolsInFile(fileSymbols, task, terms)

    let verdictStr = item.score ? `[Relevance score: ${(item.score * 100).toFixed(0)}%]` : undefined
    const rel = item.evaluations?.['relevance']
    if (rel && rel.type === 'check') {
      verdictStr = `[Jev: ${rel.verdict} (p=${(rel.probability * 100).toFixed(0)}%)]`
    }

    if (matchingSymbols.length === 0) {
      // Outline fallback
      const outlineSymbols: ExtractedSymbol[] = fileSymbols.slice(0, 15).map((s) => ({
        candidate: { file: item.file, symbol: s.name, confidence: item.score },
        code: '',
        signature: s.signature || s.name,
        doc: s.doc,
        imports: [],
        importedBy: [],
        extractionOk: true,
        startLine: s.line,
        endLine: s.line,
      }))
      filePayloads.push({
        file: item.file,
        score: item.score,
        verdict: verdictStr,
        isOutline: true,
        symbols: outlineSymbols,
        relatedTypes: [],
        outlineMessage: `// No symbol matched query identifiers in this file`,
      })
      allExtractedSymbols.push(...outlineSymbols)
      continue
    }

    // Extract matching symbols
    const extractedForFile: ExtractedSymbol[] = []
    const relatedTypesForFile: { name: string; file: string; line: number; code: string }[] = []

    for (const sym of matchingSymbols) {
      const candidate: LLMCandidate = {
        file: sym.file,
        symbol: sym.name,
        confidence: item.score,
      }
      const extracted = await extractWithOxc(candidate, map, summaryOnly, targetRoot)
      const graphImporters = await findDeps(candidate.symbol, candidate.file, map)
      extracted.importedBy = graphImporters
      extractedForFile.push(extracted)
      allExtractedSymbols.push(extracted)

      // Find related types
      if (!summaryOnly && extracted.code) {
        const related = findRelatedTypesInCode(extracted.code, map, sym.file)
        for (const rt of related) {
          const typeSlice = await readTypeSlice(targetRoot, rt)
          if (typeSlice) {
            relatedTypesForFile.push({
              name: rt.name,
              file: rt.file,
              line: rt.line,
              code: typeSlice,
            })
          }
        }
      }
    }

    filePayloads.push({
      file: item.file,
      score: item.score,
      verdict: verdictStr,
      isOutline: false,
      symbols: extractedForFile,
      relatedTypes: relatedTypesForFile,
    })
  }

  // 7. Apply Budget Waterfall
  const { markdown, omittedFilesCount, isFolded } = renderWithBudgetWaterfall(
    filePayloads,
    maxChars,
    jevRes.degraded,
  )

  const topConfidence = survivingFiles[0]?.score ?? 1.0
  const reason = jevRes.degraded
    ? 'Identified via deterministic candidate matching (Jev offline).'
    : 'Filtered and verified via TypeSafe Jev System-1.'

  const hints: string[] = []
  if (omittedFilesCount > 0) hints.push(`Omitted ${omittedFilesCount} lower-priority files due to char budget limit.`)
  if (isFolded) hints.push('Code bodies folded to signatures due to char budget limit.')

  const followUpQueries = allExtractedSymbols
    .filter((s) => s.candidate.symbol !== FILE_CONTEXT_SYMBOL)
    .slice(0, 5)
    .map((s) => `trace_symbol: ${s.candidate.symbol}`)

  return toStructuredJSON(
    markdown,
    allExtractedSymbols,
    topConfidence,
    reason,
    hints,
    followUpQueries,
    map,
  )
}

/** Traces callers, re-exports, and dependencies of a symbol. */
export async function runTraceSymbolPipeline(
  symbolName: string,
  file?: string,
  targetRoot = process.cwd(),
): Promise<ToolResultPayload> {
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
): Promise<ToolResultPayload> {
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
): Promise<ToolResultPayload> {
  return runFindCodePipeline(task, config, true, targetRoot, { maxFiles: 10, maxSymbols: 20 })
}
