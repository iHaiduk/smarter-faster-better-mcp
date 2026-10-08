import * as crypto from 'node:crypto'
import { getParserEngineForFile } from '../constants/extensions.js'
import type { ParserMode } from '../types/index.js'

export interface CacheKeyInput {
  readonly file: string
  readonly symbol: string
  readonly summaryOnly: boolean
  readonly parserMode?: ParserMode | string
}

/** Builds a stable, human-readable L1 cache key. */
export function buildCacheKey(input: CacheKeyInput): string {
  const mode = (input.parserMode as ParserMode) ?? 'auto'
  const engine = getParserEngineForFile(input.file, mode) ?? mode
  return `${engine}::${input.file}::${input.symbol}::${input.summaryOnly}`
}

/** SHA-256 hash of `buildCacheKey(input)` — used by the L2 disk cache. */
export function hashCacheKey(input: CacheKeyInput): string {
  const key = buildCacheKey(input)
  return crypto.createHash('sha256').update(key).digest('hex')
}
