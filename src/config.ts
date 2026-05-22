// Refactored: 2026-05-21 — modern JS/TS
import * as path from 'node:path'

import type { ScoutConfig } from './types.js'

export const getMapFilePath = (targetRoot: string): string => path.join(targetRoot, '.project_map.json')
export const getCacheDir = (targetRoot: string): string => path.join(targetRoot, '.scout-cache')

export const MAX_SYMBOLS = 2000
export const MAX_SYMBOLS_FOR_LLM = 150
export const PARSE_CHUNK_SIZE = 20

export const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'for', 'to', 'in', 'of', 'and', 'or', 'is', 'it', 'how',
  'where', 'what', 'find', 'get', 'use', 'with', 'that', 'this', 'does', 'do',
  'can', 'should', 'want', 'need', 'make', 'from', 'about', 'show', 'return',
  'create', 'add', 'update',
] as const)

// System prompt: STRICTLY <= 200 tokens. Small models fail on large prompts.
export const SYSTEM_PROMPT = `You are a code search assistant.
Given a symbol map and task, find matching symbols and assign a relevance tier.
Tiers: "mustRead" (direct match/to edit), "likelyRelevant" (very relevant), "dependencyOnly" (just dependency/stub only).
Output ONLY valid JSON. Format: {"candidates":[{"file":"path.ts","symbol":"Name","confidence":0.9,"tier":"mustRead"}]}`

const DEFAULTS = {
  llmTimeoutMs: 30_000,
  confidenceThreshold: 0.5,
  llmParallelism: 2,
} as const

export class MissingConfigError extends Error {
  override readonly name = 'MissingConfigError'
}

/** Loads Scout configuration from environment variables. */
export function loadConfig(): ScoutConfig {
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
    confidenceThreshold: num(process.env['SCOUT_CONFIDENCE_THRESHOLD'], DEFAULTS.confidenceThreshold),
    llmParallelism: num(process.env['SCOUT_LLM_PARALLELISM'], DEFAULTS.llmParallelism),
  } satisfies ScoutConfig
}
