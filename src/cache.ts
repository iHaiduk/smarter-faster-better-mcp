// Refactored: 2026-05-21 — modern JS/TS
import { MAP_FILE } from './config.js'

import type { ExtractedSymbol } from './types.js'

// ─── L1: In-memory Cache ────────────────────────────────────────────────────
export const l1Cache = new Map<string, ExtractedSymbol>()

/** Build a stable cache key for an extracted symbol. */
export function l1Key(file: string, symbol: string, summaryOnly = false): string {
  return `${file}::${symbol}::${summaryOnly}`
}

/** Clears the L1 cache. Must be called on every map rebuild. */
export function clearL1(): void {
  l1Cache.clear()
  console.error('[Scout] L1 cache cleared')
}

const STALE_FALLBACK_MS = 5 * 60 * 1000

/** Returns true when any tracked file is newer than the cached project map. */
export async function isCacheStale(): Promise<boolean> {
  const mapFile = Bun.file(MAP_FILE)
  if (!(await mapFile.exists())) return true

  try {
    // `find ... -quit` stops on the first match for speed.
    const proc = Bun.spawn(
      [
        'find', '.',
        '-newer', MAP_FILE,
        '(', '-name', '*.ts', '-o', '-name', '*.tsx', ')',
        '-not', '-path', '*/node_modules/*',
        '-not', '-path', '*/.git/*',
        '-not', '-path', '*/dist/*',
        '-not', '-path', '*/build/*',
        '-print', '-quit',
      ],
      { stdout: 'pipe', stderr: 'ignore' },
    )
    const out = await new Response(proc.stdout).text()
    return out.trim().length > 0
  } catch {
    console.error('[Scout] find not available, using 5min time-based cache')
    const stat = await mapFile.stat().catch(() => null)
    if (!stat) return true
    return Date.now() - stat.mtime.getTime() > STALE_FALLBACK_MS
  }
}
