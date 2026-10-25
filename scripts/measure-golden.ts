import * as path from 'node:path'
import { runFindCodePipeline } from '../src/pipeline/index.js'
import { loadConfig } from '../src/config/index.js'

export interface GoldenQuestion {
  readonly question: string
  readonly expectedFile: string
  readonly expectedSymbol: string
}

export const GOLDEN_SET: readonly GoldenQuestion[] = [
  {
    question: 'where is the file-context slice built',
    expectedFile: 'src/pipeline/index.ts',
    expectedSymbol: 'runGetFileContext',
  },
  {
    question: 'where are MCP tools registered on the server',
    expectedFile: 'src/tools/registerTools.ts',
    expectedSymbol: 'registerAllTools',
  },
  {
    question: 'how are AST nodes extracted using OXC',
    expectedFile: 'src/extraction/extract.ts',
    expectedSymbol: 'extractWithOxc',
  },
  {
    question: 'deterministic map filtering and keyword matching',
    expectedFile: 'src/extraction/matcher/filter.ts',
    expectedSymbol: 'filterMap',
  },
  {
    question: 'where is dynamic triage batch evaluation with Jev implemented',
    expectedFile: 'src/extraction/jev/dynamic-triage.ts',
    expectedSymbol: 'runDynamicTriage',
  },
  {
    question: 'how is the project symbol map built from files',
    expectedFile: 'src/indexing/symbol-map/build-map.ts',
    expectedSymbol: 'buildMap',
  },
  {
    question: 'where is dead code detection and unused export analysis',
    expectedFile: 'src/analysis/dead-code/index.ts',
    expectedSymbol: 'analyzeDeadCode',
  },
  {
    question: 'where is the markdown and structured output formatter for LLM',
    expectedFile: 'src/bundle/formatter/format.ts',
    expectedSymbol: 'formatFound',
  },
  {
    question: 'how are file dependencies and imports resolved',
    expectedFile: 'src/dependency-resolver/deps.ts',
    expectedSymbol: 'findDeps',
  },
  {
    question: 'where is the blast radius impact analysis implemented',
    expectedFile: 'src/tools/blastRadiusTool.ts',
    expectedSymbol: 'registerBlastRadiusTool',
  },
]

export interface MeasurementResult {
  readonly question: string
  readonly expectedFile: string
  readonly expectedSymbol: string
  readonly hit: boolean
  readonly chars: number
  readonly latencyMs: number
}

export interface SummaryStats {
  readonly total: number
  readonly hits: number
  readonly hitRate: string
  readonly medianChars: number
  readonly p95LatencyMs: number
  readonly results: readonly MeasurementResult[]
}

export async function runMeasurements(targetRoot = path.resolve(import.meta.dir, '..')): Promise<SummaryStats> {
  const config = loadConfig()
  const results: MeasurementResult[] = []

  for (const item of GOLDEN_SET) {
    const start = performance.now()
    const output = await runFindCodePipeline(item.question, config, false, targetRoot)
    const latencyMs = Math.round(performance.now() - start)
    const chars = output.length

    // Check hit: either structured output or text contains expected symbol
    const hit = output.includes(item.expectedSymbol) && output.includes(item.expectedFile)

    results.push({
      question: item.question,
      expectedFile: item.expectedFile,
      expectedSymbol: item.expectedSymbol,
      hit,
      chars,
      latencyMs,
    })
  }

  const hits = results.filter((r) => r.hit).length
  const sortedChars = [...results.map((r) => r.chars)].sort((a, b) => a - b)
  const medianChars = sortedChars[Math.floor(sortedChars.length / 2)] ?? 0

  const sortedLatencies = [...results.map((r) => r.latencyMs)].sort((a, b) => a - b)
  const p95Index = Math.min(sortedLatencies.length - 1, Math.floor(sortedLatencies.length * 0.95))
  const p95LatencyMs = sortedLatencies[p95Index] ?? 0

  return {
    total: GOLDEN_SET.length,
    hits,
    hitRate: `${hits}/${GOLDEN_SET.length}`,
    medianChars,
    p95LatencyMs,
    results,
  }
}

if (import.meta.main) {
  console.log('[Golden Set] Running baseline measurement...')
  const summary = await runMeasurements()

  console.log('\n--- Individual Question Results ---')
  for (const r of summary.results) {
    console.log(
      `[${r.hit ? 'HIT ' : 'MISS'}] "${r.question}" -> ${r.expectedFile}::${r.expectedSymbol} | chars: ${r.chars} | latency: ${r.latencyMs}ms`,
    )
  }

  console.log('\n=== Summary ===')
  console.log(`Hits: ${summary.hitRate}`)
  console.log(`Median chars: ${summary.medianChars}`)
  console.log(`P95 Latency: ${summary.p95LatencyMs}ms`)
}
