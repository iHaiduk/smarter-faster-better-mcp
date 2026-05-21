// Refactored: 2026-05-21 — modern JS/TS
import { loadConfig } from '../config.js'
import { findDeps } from '../deps.js'
import { buildMap } from '../parser.js'
import { extractWithOxc, filterMap, formatFound, runFindCodePipeline } from '../pipeline.js'

import type { ProjectMap, SymbolEntry } from '../types.js'

const COLOR = {
  reset: '\x1b[0m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
} as const

const TOKEN_CHARS = 4
const MOCK_PROMPT_TOKENS = 127
const MOCK_RESPONSE_TOKENS = 18
const MOCK_SAVED_MAP_TOKENS = 524

const paint = (color: keyof typeof COLOR, text: string | number): string =>
  `${COLOR[color]}${text}${COLOR.reset}`

async function run(): Promise<void> {
  const args = process.argv.slice(2)
  const summaryOnly = args.includes('--summary')
  const query = args.filter((arg) => arg !== '--summary').join(' ') || 'lang'

  console.log(`\n${paint('magenta', '=== MCP Scout CLI Test Runner ===')}`)
  console.log(`Searching for: "${paint('cyan', query)}" (summaryOnly: ${paint('yellow', String(summaryOnly))})`)

  console.log('\n[1/4] Initialize parser (OXC is instant)')
  console.log('\n[2/4] Checking AST project map...')

  let map: ProjectMap
  try {
    map = await buildMap()
    console.log(`  ${paint('green', '✓ Project map built successfully!')}`)
    const fileCount = new Set(map.symbols.map((sym) => sym.file)).size
    console.log(`  Files found: ${paint('yellow', fileCount)}`)
    console.log(`  Total symbols: ${paint('yellow', map.symbolsCount)}`)
  } catch (err) {
    console.error(`  ${paint('red', '✗ AST parsing error:')}`, err)
    process.exit(1)
  }

  console.log('\n[3/4] Local keyword filtering:')
  const localFiltered = filterMap(map, query)
  if (localFiltered.length === 0) {
    console.log(`  ${paint('yellow', 'No symbols matched local keywords.')}`)
  } else {
    console.log(`  Matched symbols: ${paint('green', localFiltered.length)}`)
    localFiltered.slice(0, 5).forEach((sym, idx) => {
      console.log(`    ${idx + 1}. ${paint('cyan', sym.name)} (${sym.kind}) -> ${paint('gray', sym.file)}`)
    })
    if (localFiltered.length > 5) {
      console.log(`    ... and ${localFiltered.length - 5} more symbols`)
    }
  }

  console.log('\n[4/4] Running full LLM pipeline...')

  const { SCOUT_BASE_URL: baseUrl, SCOUT_MODEL: model, SCOUT_API_KEY: apiKey } = process.env
  if (!baseUrl || !model || !apiKey) {
    console.log(`  ${paint('yellow', '⚠ SCOUT_* env variables are not fully set.')}`)
    console.log('  For a full LLM test, set them in .env or run with:')
    console.log('  SCOUT_BASE_URL=... SCOUT_API_KEY=... SCOUT_MODEL=... bun run src/bin/test-scout.ts')
    console.log(`\n${paint('green', '=== Local AST test passed successfully! ===')}\n`)
    return
  }

  console.log(`  Using LLM: ${paint('cyan', model)} on ${paint('cyan', baseUrl)}`)

  try {
    const config = loadConfig()
    const result = await runFindCodePipeline(query, config, summaryOnly)

    if (result.includes('[Scout: DEGRADED]') && localFiltered.length > 0) {
      await runMockPipeline(map, localFiltered, summaryOnly)
      return
    }

    console.log(`\n${paint('magenta', '=== PIPELINE RESULT ===')}`)
    console.log(result)
    console.log(paint('magenta', '===================================='))
    console.log()
  } catch (err) {
    console.error(`  ${paint('red', '✗ Pipeline finished with error:')}`, err)
  }
}

async function runMockPipeline(
  map: ProjectMap,
  localFiltered: readonly SymbolEntry[],
  summaryOnly: boolean,
): Promise<void> {
  console.log(`\n  ${paint('yellow', '⚠ LLM unavailable. Mocking a successful response for the top match...')}`)

  const topSymbol = localFiltered.at(0)
  if (!topSymbol) return

  const mockCandidate = {
    file: topSymbol.file,
    symbol: topSymbol.name,
    confidence: 0.99,
  } as const

  const extraction = await extractWithOxc(mockCandidate, map, summaryOnly)
  extraction.importedBy = await findDeps(mockCandidate.symbol, mockCandidate.file)

  const mockResult = formatFound([extraction])
  const original = extraction.fullLength ?? extraction.code.length
  const savedCollapseTokens = Math.ceil(Math.max(0, original - extraction.code.length) / TOKEN_CHARS)
  const totalSaved = MOCK_SAVED_MAP_TOKENS + savedCollapseTokens

  const infoLines = [
    '',
    '---',
    '[Scout: TOKENS / METRICS]',
    `• Small LLM usage: ~${MOCK_PROMPT_TOKENS + MOCK_RESPONSE_TOKENS} tokens (Prompt: ~${MOCK_PROMPT_TOKENS}, Response: ~${MOCK_RESPONSE_TOKENS})`,
    `• Map filtering saved: ~${MOCK_SAVED_MAP_TOKENS} tokens`,
    summaryOnly
      ? `• Code collapsing saved: ~${savedCollapseTokens} tokens`
      : '• Code collapsing (summaryOnly) inactive. You could save more tokens!',
    `• Total tokens saved: ~${totalSaved} tokens`,
  ].join('\n')

  console.error(infoLines)
  console.log(`\n${paint('magenta', '=== PIPELINE MOCK RESULT ===')}`)
  console.log(mockResult)
  console.log(paint('magenta', '===================================================='))
  console.log()
}

await run()
