// Refactored: 2026-05-21 — modern JS/TS
// Thin orchestrator: cache → filter → cheap LLM → extract → format.
// All heavy lifting now lives in dedicated modules; this file just composes them.

import { isCacheStale, l1Cache, l1Key } from './cache.js'
import { MAP_FILE, SYSTEM_PROMPT } from './config.js'
import { extractWithOxc } from './extract.js'
import { filterMap } from './filter.js'
import { formatDegraded, formatFound, formatNotFound, serializeForLLM } from './format.js'
import { getGitStatusMap } from './git.js'
import { askCheapLLM, getGitHint } from './llm.js'
import { findDeps } from './deps.js'
import { buildMap } from './parser.js'
import { l2Get, l2Set } from './l2cache.js'

import type { ExtractedSymbol, LLMCandidate, ProjectMap, ScoutConfig, SymbolEntry } from './types.js'

// Public re-exports preserve the historical API surface.
export {
  extractWithOxc,
  extractTypeDefinitions,
} from './extract.js'
export { filterMap, getEditDistance } from './filter.js'
export {
  formatFound,
  formatNotFound,
  formatDegraded,
  serializeForLLM,
  kindShort,
} from './format.js'
export { getGitStatusMap } from './git.js'

const TOKEN_CHARS = 4
const MAX_CHUNKS = 5

function chunkSymbols(symbols: readonly SymbolEntry[], chunkCount: number): SymbolEntry[][] {
  const buckets: SymbolEntry[][] = Array.from({ length: chunkCount }, () => [])
  symbols.forEach((sym, idx) => {
    buckets[idx % chunkCount]!.push(sym)
  })
  return buckets.filter((bucket) => bucket.length > 0)
}

async function readMap(): Promise<ProjectMap> {
  try {
    return (await Bun.file(MAP_FILE).json()) as ProjectMap
  } catch {
    return await buildMap()
  }
}

function approximateTokens(charCount: number): number {
  return Math.ceil(charCount / TOKEN_CHARS)
}

async function lookupCached(
  candidate: LLMCandidate,
  summaryOnly: boolean,
): Promise<ExtractedSymbol | null> {
  const key = l1Key(candidate.file, candidate.symbol, summaryOnly)
  const inMemory = l1Cache.get(key)
  if (inMemory) return inMemory

  const onDisk = await l2Get(candidate.file, candidate.symbol, summaryOnly)
  if (onDisk) {
    l1Cache.set(key, onDisk)
    return onDisk
  }
  return null
}

async function storeCached(value: ExtractedSymbol, summaryOnly: boolean): Promise<void> {
  const { file, symbol } = value.candidate
  l1Cache.set(l1Key(file, symbol, summaryOnly), value)
  await l2Set(file, symbol, summaryOnly, value)
}

/** Runs the full find_code pipeline and returns formatted output for the caller LLM. */
export async function runFindCodePipeline(
  task: string,
  config: ScoutConfig,
  summaryOnly = false,
): Promise<string> {
  if (await isCacheStale()) await buildMap()

  const map = await readMap()
  if (map.symbols.length === 0) return formatNotFound(task, 0)

  const filtered = filterMap(map, task)
  const chunkCount = Math.max(1, Math.min(config.llmParallelism, MAX_CHUNKS))
  const chunks = chunkSymbols(filtered, chunkCount)

  const [compactMaps, gitHint] = await Promise.all([
    Promise.resolve(chunks.map(serializeForLLM)),
    getGitHint(),
  ])

  const firstChunkPrompt = [
    `Task: ${task}`,
    gitHint && `Recently modified: ${gitHint}`,
    `Symbols:\n${compactMaps[0] ?? ''}`,
  ]
    .filter(Boolean)
    .join('\n\n')
  const promptTokens = approximateTokens(SYSTEM_PROMPT.length + firstChunkPrompt.length)

  const candidates = await askCheapLLM(task, compactMaps, gitHint, config)
  if (!candidates) return formatDegraded('LLM unavailable or timed out')

  const good = candidates.filter((c) => c.confidence >= config.confidenceThreshold)
  if (good.length === 0) return formatNotFound(task, map.symbolsCount)

  const cachedResults: ExtractedSymbol[] = []
  const uncachedCandidates: LLMCandidate[] = []
  for (const candidate of good) {
    const cached = await lookupCached(candidate, summaryOnly)
    if (cached) cachedResults.push(cached)
    else uncachedCandidates.push(candidate)
  }

  const gitStatusMap = await getGitStatusMap()

  let extractions: ExtractedSymbol[] = []
  if (uncachedCandidates.length > 0) {
    const [exts, depsResults] = await Promise.all([
      Promise.all(uncachedCandidates.map((c) => extractWithOxc(c, map, summaryOnly))),
      Promise.all(uncachedCandidates.map((c) => findDeps(c.symbol, c.file))),
    ])

    exts.forEach((ext, idx) => {
      ext.importedBy = depsResults[idx] ?? []
    })

    await Promise.all(exts.map((ext) => storeCached(ext, summaryOnly)))
    extractions = exts
  }

  const allResults = [...cachedResults, ...extractions]
  const mainOutput = formatFound(allResults, gitStatusMap)

  const responseTokens = approximateTokens(JSON.stringify({ candidates }).length)
  const fullPrompt = [
    `Task: ${task}`,
    gitHint && `Recently modified: ${gitHint}`,
    `Symbols:\n${serializeForLLM(map.symbols)}`,
  ]
    .filter(Boolean)
    .join('\n\n')
  const fullPromptTokens = approximateTokens(SYSTEM_PROMPT.length + fullPrompt.length)
  const savedMapTokens = Math.max(0, fullPromptTokens - promptTokens)

  const savedCollapseChars = allResults.reduce((acc, ext) => {
    const original = ext.fullLength ?? ext.code.length
    return acc + Math.max(0, original - ext.code.length)
  }, 0)
  const savedCollapseTokens = approximateTokens(savedCollapseChars)
  const totalSaved = savedMapTokens + savedCollapseTokens

  const infoLines = [
    '',
    '---',
    '[Scout: TOKENS / METRICS]',
    `• Small LLM usage: ~${promptTokens + responseTokens} tokens (Prompt: ~${promptTokens}, Response: ~${responseTokens})`,
    `• Map filtering saved: ~${savedMapTokens} tokens`,
    summaryOnly
      ? `• Code collapsing saved: ~${savedCollapseTokens} tokens`
      : '• Code collapsing (summaryOnly) inactive. You could save more tokens!',
    `• Total tokens saved: ~${totalSaved} tokens`,
  ].join('\n')

  console.error(infoLines)
  return mainOutput
}
