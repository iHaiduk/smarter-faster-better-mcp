import * as path from 'node:path'
import * as fs from 'node:fs/promises'

import { getCacheDir, getParserMode } from '../config/index.js'
import { hashCacheKey } from '../shared/cache/key.js'
import { fileExists } from '../shared/utils/node.js'
import type { ExtractedSymbol } from '../shared/types/index.js'

function keyFor(file: string, symbol: string, summaryOnly: boolean): string {
  return hashCacheKey({ file, symbol, summaryOnly, parserMode: getParserMode() })
}

function entryPath(key: string, targetRoot: string): string {
  return path.join(getCacheDir(targetRoot), `${key}.json`)
}

async function getSourceMtime(file: string, targetRoot: string): Promise<number | null> {
  try {
    const stat = await fs.stat(path.join(targetRoot, file))
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
  targetRoot: string,
): Promise<ExtractedSymbol | null> {
  const key = keyFor(file, symbol, summaryOnly)
  const cPath = entryPath(key, targetRoot)
  if (!(await fileExists(cPath))) return null

  try {
    const raw = await fs.readFile(cPath, 'utf8')
    const entry = JSON.parse(raw) as { readonly sourceMtimeMs: number; readonly value: ExtractedSymbol }
    const mtime = await getSourceMtime(file, targetRoot)
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
  targetRoot: string,
): Promise<void> {
  const mtime = await getSourceMtime(file, targetRoot)
  if (mtime === null) return

  const key = keyFor(file, symbol, summaryOnly)
  const entry = { sourceMtimeMs: mtime, value }

  try {
    const dir = getCacheDir(targetRoot)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(entryPath(key, targetRoot), JSON.stringify(entry), 'utf8')
  } catch (err) {
    console.error('[Scout] L2 write failed:', err instanceof Error ? err.message : String(err))
  }
}

/** Wipe the L2 cache directory (best-effort). */
export async function l2Clear(targetRoot: string): Promise<void> {
  try {
    const dir = getCacheDir(targetRoot)
    await fs.rm(dir, { recursive: true, force: true })
  } catch {
    // ignored: cleanup is best-effort
  }
}
