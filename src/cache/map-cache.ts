import * as fs from 'node:fs/promises'

import { getMapFilePath, projectMapMatchesParserMode } from '../config/index.js'
import { fileExists } from '../shared/utils/node.js'
import { buildMap } from '../indexing/symbol-map/build-map.js'
import { l1Cache, l1Key } from './l1.js'
import { l2Get, l2Set } from './l2.js'

import type { ExtractedSymbol, LLMCandidate, ProjectMap, SymbolEntry } from '../shared/types/index.js'

import { getWorkspaceWatcher } from '../indexing/watcher/index.js'

/** Reads the persisted project map from disk, or rebuilds it on miss/schema mismatch. */
export async function readMap(targetRoot: string): Promise<ProjectMap> {
  const watcher = getWorkspaceWatcher(targetRoot)
  const cachedFromWatcher = watcher.getMap()
  if (cachedFromWatcher) {
    return cachedFromWatcher
  }

  const mapPath = getMapFilePath(targetRoot)
  try {
    if (await fileExists(mapPath)) {
      const content = await fs.readFile(mapPath, 'utf8')
      const data = JSON.parse(content) as ProjectMap
      if (
        data &&
        Array.isArray(data.files) &&
        data.files.length > 0 &&
        projectMapMatchesParserMode(data)
      ) {
        watcher.setMap(data)
        return data
      }
    }
  } catch (err) {
    console.error('[Scout] Failed to read project map, rebuilding:', err instanceof Error ? err.message : String(err))
  }
  const builtMap = await buildMap(targetRoot)
  watcher.setMap(builtMap)
  return builtMap
}

/** Checks L1 (memory) then L2 (disk) caches for an already-extracted symbol. */
export async function lookupCached(
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

/** Persists an extracted symbol to both L1 and L2 caches. */
export async function storeCached(
  value: ExtractedSymbol,
  summaryOnly: boolean,
  targetRoot: string,
): Promise<void> {
  const { file, symbol } = value.candidate
  l1Cache.set(l1Key(file, symbol, summaryOnly), value)
  await l2Set(file, symbol, summaryOnly, value, targetRoot)
}

/** Composes a bucketed set of symbols for the cheap LLM to consume in parallel chunks. */
export function chunkSymbols(symbols: readonly SymbolEntry[], chunkCount: number): SymbolEntry[][] {
  const buckets: SymbolEntry[][] = Array.from({ length: chunkCount }, () => [])
  symbols.forEach((sym, idx) => {
    buckets[idx % chunkCount]!.push(sym)
  })
  return buckets.filter((bucket) => bucket.length > 0)
}
