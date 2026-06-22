import * as crypto from 'node:crypto'

import type { QueryAnalysis } from '../shared/types/index.js'

const CACHE_MAX_SIZE = 64
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes

interface CacheEntry {
  readonly analysis: QueryAnalysis
  readonly timestamp: number
}

const queryCache = new Map<string, CacheEntry>()

function hashQuery(task: string): string {
  return crypto.createHash('sha256').update(task.trim().toLowerCase()).digest('hex').slice(0, 16)
}

/**
 * Gets a cached query analysis result if available and not expired.
 * Returns null on cache miss or expiration.
 */
export function getCachedAnalysis(task: string): QueryAnalysis | null {
  const key = hashQuery(task)
  const entry = queryCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    queryCache.delete(key)
    return null
  }
  return entry.analysis
}

/**
 * Caches a query analysis result.
 * Evicts oldest entries if cache is full.
 */
export function setCachedAnalysis(task: string, analysis: QueryAnalysis): void {
  if (queryCache.size >= CACHE_MAX_SIZE) {
    const oldestKey = queryCache.keys().next().value
    if (oldestKey) queryCache.delete(oldestKey)
  }
  const key = hashQuery(task)
  queryCache.set(key, { analysis, timestamp: Date.now() })
}

/** Clears the query cache. Useful for tests to avoid cross-test pollution. */
export function clearQueryCache(): void {
  queryCache.clear()
}
