// Refactored: 2026-05-21 — modern JS/TS
// L2 disk cache for extracted symbols.
// Keyed by sha-256(file::symbol::summaryOnly); invalidated by source mtime.

import * as path from 'node:path'

import type { ExtractedSymbol } from './types.js'

const CACHE_DIR = path.join(process.cwd(), '.scout-cache')

interface CacheEntry {
  readonly sourceMtimeMs: number
  readonly value: ExtractedSymbol
}

function keyFor(file: string, symbol: string, summaryOnly: boolean): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(`${file}::${symbol}::${summaryOnly}`)
  return hasher.digest('hex')
}

function entryPath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`)
}

async function getSourceMtime(file: string): Promise<number | null> {
  try {
    const stat = await Bun.file(path.join(process.cwd(), file)).stat()
    return stat.mtime.getTime()
  } catch {
    return null
  }
}

/** Look up a cached extraction; returns `null` on miss or when the source is newer. */
export async function l2Get(
  file: string,
  symbol: string,
  summaryOnly: boolean,
): Promise<ExtractedSymbol | null> {
  const key = keyFor(file, symbol, summaryOnly)
  const cacheFile = Bun.file(entryPath(key))
  if (!(await cacheFile.exists())) return null

  try {
    const entry = (await cacheFile.json()) as CacheEntry
    const mtime = await getSourceMtime(file)
    if (mtime === null || mtime > entry.sourceMtimeMs) return null
    return entry.value
  } catch {
    return null
  }
}

/** Persist an extraction. Best-effort: write errors are logged but never thrown. */
export async function l2Set(
  file: string,
  symbol: string,
  summaryOnly: boolean,
  value: ExtractedSymbol,
): Promise<void> {
  const mtime = await getSourceMtime(file)
  if (mtime === null) return

  const key = keyFor(file, symbol, summaryOnly)
  const entry: CacheEntry = { sourceMtimeMs: mtime, value }

  try {
    await Bun.write(entryPath(key), JSON.stringify(entry))
  } catch (err) {
    console.error('[Scout] L2 write failed:', err instanceof Error ? err.message : String(err))
  }
}

/** Wipe the L2 cache directory (best-effort). */
export async function l2Clear(): Promise<void> {
  try {
    await Bun.spawn(['rm', '-rf', CACHE_DIR]).exited
  } catch {
    // ignored: cleanup is best-effort
  }
}
