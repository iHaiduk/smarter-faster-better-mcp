import * as path from 'node:path'
import dotenv from 'dotenv'

import type { ParserMode, ProjectMap, ScoutConfig } from '../shared/types/index.js'
import { MissingConfigError, InvalidParserModeError } from '../shared/errors/config-errors.js'

export { MissingConfigError, InvalidParserModeError } from '../shared/errors/config-errors.js'
export { STOP_WORDS } from '../shared/prompts/stop-words.js'
export { SYSTEM_PROMPT } from '../shared/prompts/system-prompt.js'
export { getSourceExtensions } from '../shared/constants/extensions.js'

export const getMapFilePath = (targetRoot: string): string => path.join(targetRoot, '.project_map.json')
export const getCacheDir = (targetRoot: string): string => path.join(targetRoot, '.scout-cache')

export const MAX_SYMBOLS = 2000
export const MAX_SYMBOLS_FOR_LLM = 150
export const PARSE_CHUNK_SIZE = 20

const DEFAULTS = {
  llmTimeoutMs: 30_000,
  llmParallelism: 2,
} as const

function normalizeParserMode(raw: string | undefined): ParserMode | null {
  if (!raw) return null
  const value = raw.trim().toLowerCase()
  if (value === 'oxc' || value === 'oxc-parser') return 'oxc'
  if (value === 'tree-sitter' || value === 'web-tree-sitter') return 'tree-sitter'
  throw new InvalidParserModeError(
    `Invalid parser mode "${raw}". Expected "oxc" or "tree-sitter".`,
  )
}

export function getParserMode(argv: readonly string[] = process.argv): ParserMode {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--tree-sitter') return 'tree-sitter'
    if (arg?.startsWith('--parser=')) {
      return normalizeParserMode(arg.slice('--parser='.length)) ?? 'oxc'
    }
    if (arg === '--parser') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) {
        throw new InvalidParserModeError(
          'Missing parser mode after --parser. Expected "oxc" or "tree-sitter".',
        )
      }
      return normalizeParserMode(value) ?? 'oxc'
    }
  }

  return normalizeParserMode(process.env['SCOUT_PARSER']) ?? 'oxc'
}

export function projectMapMatchesParserMode(map: ProjectMap, parserMode = getParserMode()): boolean {
  return map.parserMode === parserMode
}

/** Loads Scout configuration from environment variables and CLI flags. */
export function loadConfig(): ScoutConfig {
  dotenv.config({ quiet: true })
  const { SCOUT_BASE_URL: baseUrl, SCOUT_API_KEY: apiKey, SCOUT_MODEL: model } = process.env

  if (!baseUrl || !apiKey || !model) {
    throw new MissingConfigError(
      'Missing env vars: SCOUT_BASE_URL, SCOUT_API_KEY, SCOUT_MODEL',
    )
  }

  const num = (raw: string | undefined, fallback: number): number => {
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }

  return {
    baseUrl,
    apiKey,
    model,
    llmTimeoutMs: num(process.env['SCOUT_LLM_TIMEOUT_MS'], DEFAULTS.llmTimeoutMs),
    llmParallelism: num(process.env['SCOUT_LLM_PARALLELISM'], DEFAULTS.llmParallelism),
    parser: getParserMode(),
  } satisfies ScoutConfig
}
