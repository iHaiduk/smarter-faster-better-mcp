import * as fs from 'node:fs/promises'
import {
  getMapFilePath,
  getParserMode,
  projectMapMatchesParserMode,
} from '../config/index.js'
import { getSourceExtensions } from '../shared/constants/extensions.js'
import { ignoreFindArgs } from '../shared/constants/ignore-rules.js'
import { buildCacheKey } from '../shared/cache/key.js'
import { fileExists, runCommand } from '../shared/utils/node.js'

import type { ExtractedSymbol, ParserMode, ProjectMap } from '../shared/types/index.js'

// ─── L1: In-memory Cache ────────────────────────────────────────────────────
export const l1Cache = new Map<string, ExtractedSymbol>()

/** Build a stable cache key for an extracted symbol. */
export function l1Key(
  file: string,
  symbol: string,
  summaryOnly = false,
  parserMode: ParserMode = getParserMode(),
): string {
  return buildCacheKey({ file, symbol, summaryOnly, parserMode })
}

/** Clears the L1 cache. Must be called on every map rebuild. */
export function clearL1(): void {
  l1Cache.clear()
  console.error('[Scout] L1 cache cleared')
}

const STALE_FALLBACK_MS = 5 * 60 * 1000

function findNameArgs(extensions: ReadonlySet<string>): string[] {
  return [...extensions].flatMap((ext, idx) => {
    const pair = ['-name', `*${ext}`]
    return idx === 0 ? pair : ['-o', ...pair]
  })
}

/** Returns true when any tracked file is newer than the cached project map. */
export async function isCacheStale(targetRoot: string): Promise<boolean> {
  const mapPath = getMapFilePath(targetRoot)
  if (!(await fileExists(mapPath))) return true
  const parserMode = getParserMode()

  try {
    const map = JSON.parse(await fs.readFile(mapPath, 'utf8')) as ProjectMap
    if (!projectMapMatchesParserMode(map, parserMode)) return true
  } catch {
    return true
  }

  try {
    // `find ... -quit` stops on the first match for speed.
    const nameArgs = findNameArgs(getSourceExtensions(parserMode))
    const out = await runCommand(
      [
        'find', '.',
        '-newer', mapPath,
        '(',
        ...nameArgs,
        ')',
        ...ignoreFindArgs(),
        '-print', '-quit',
      ],
      targetRoot,
    )
    return out.trim().length > 0
  } catch {
    console.error('[Scout] find not available, using 5min time-based cache')
    const stat = await fs.stat(mapPath).catch(() => null)
    if (!stat) return true
    return Date.now() - stat.mtime.getTime() > STALE_FALLBACK_MS
  }
}
