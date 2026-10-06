import { readMap } from '../../cache/map-cache.js'
import { isCacheStale } from '../../cache/l1.js'
import { buildMap } from '../../indexing/symbol-map/build-map.js'
import { evaluateDynamicCriteriaBatch } from './client.js'
import { isTestFile } from '../../shared/constants/test-suffixes.js'

import type {
  CandidateEvaluation,
  DynamicTriageRequest,
  DynamicTriageResponse,
  FileMetadata,
  ProjectMap,
  ScoutConfig,
} from '../../shared/types/index.js'

function getFileMeta(map: ProjectMap, filePath: string): FileMetadata | undefined {
  if (!map.files) return undefined
  return map.files.find((f) => f.file === filePath)
}

/**
 * Builds a compressed, AST-level representation of a candidate file to pass to Jev.
 * Keeps input tokens minimal (<250 tokens per file).
 */
export function buildAstStateForFile(map: ProjectMap, filePath: string) {
  const meta = getFileMeta(map, filePath)
  const fileSymbols = map.symbols.filter((s) => s.file === filePath)

  const exports = meta?.exports.map((e) => e.name) ?? []
  const dependencies = meta?.imports.map((i) => i.source) ?? []
  const signatures = fileSymbols.slice(0, 10).map((s) => s.signature || s.name)

  return {
    file: filePath,
    exports,
    dependencies: dependencies.slice(0, 10),
    keySignatures: signatures,
  }
}

/**
 * Filter down the whole repository to an initial coarse candidate set (e.g. 5-10 files)
 * using deterministic AST hints, file names, or symbols before running Jev System-1.
 */
export function selectCoarseCandidates(
  map: ProjectMap,
  hints: readonly string[],
  explicitFiles?: readonly string[],
  limit = 8,
): string[] {
  if (explicitFiles && explicitFiles.length > 0) {
    return explicitFiles.slice(0, limit)
  }

  if (hints.length === 0) {
    // Fallback: take top files by symbol count (excluding test files)
    const fileSymbolCounts = new Map<string, number>()
    for (const sym of map.symbols) {
      if (!isTestFile(sym.file)) {
        fileSymbolCounts.set(sym.file, (fileSymbolCounts.get(sym.file) ?? 0) + 1)
      }
    }
    return Array.from(fileSymbolCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([f]) => f)
  }

  const scores = new Map<string, number>()
  const lowerHints = hints.map((h) => h.toLowerCase().trim()).filter(Boolean)

  for (const sym of map.symbols) {
    if (isTestFile(sym.file)) continue

    const symLower = sym.name.toLowerCase()
    const fileLower = sym.file.toLowerCase()

    let matchWeight = 0
    for (const hint of lowerHints) {
      if (symLower === hint) matchWeight += 10
      else if (symLower.includes(hint)) matchWeight += 5
      if (fileLower.includes(hint)) matchWeight += 3
    }

    if (matchWeight > 0) {
      scores.set(sym.file, (scores.get(sym.file) ?? 0) + matchWeight)
    }
  }

  // Also match against exports and imports
  if (map.files) {
    for (const meta of map.files) {
      if (isTestFile(meta.file)) continue
      let metaWeight = 0
      for (const exp of meta.exports) {
        const expLower = exp.name.toLowerCase()
        for (const hint of lowerHints) {
          if (expLower.includes(hint)) metaWeight += 4
        }
      }
      if (metaWeight > 0) {
        scores.set(meta.file, (scores.get(meta.file) ?? 0) + metaWeight)
      }
    }
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([f]) => f)
}

/**
 * Universal Dynamic Triage Engine.
 * Evaluates arbitrary AI questions against AST candidates without any hardcoded domains or schemas.
 */
export async function runDynamicTriage(
  request: DynamicTriageRequest,
  config: ScoutConfig,
  targetRoot = process.cwd(),
): Promise<DynamicTriageResponse> {
  const start = performance.now()
  if (await isCacheStale(targetRoot)) {
    await buildMap(targetRoot)
  }
  const map = await readMap(targetRoot)

  const candidateFiles = selectCoarseCandidates(
    map,
    request.searchHints ?? [],
    request.candidateFiles,
    request.limit ?? 8,
  )

  const minConfidence = request.minConfidence ?? 0.5
  const evaluatedCandidates: CandidateEvaluation[] = []

  // Evaluate candidates concurrently via Jev Single-Pass Batch
  const evalPromises = candidateFiles.map(async (filePath) => {
    const astState = buildAstStateForFile(map, filePath)
    const jevResult = await evaluateDynamicCriteriaBatch(astState, request.criteria, config)

    if (!jevResult) {
      return null
    }

    const evaluations: CandidateEvaluation['evaluations'] = {}
    let overallScore = 0
    let criteriaCount = 0

    for (const [key, crit] of Object.entries(request.criteria)) {
      const ans = (jevResult.answers as Record<string, unknown>)[key]
      if (!ans) continue

      criteriaCount++

      const ansObj = typeof ans === 'object' && ans !== null ? (ans as Record<string, unknown>) : {}

      if (crit.type === 'check') {
        const prob = typeof ansObj['noul'] === 'number' ? ansObj['noul'] : 0
        const verdict = prob >= 0.7 ? 'yes' : prob <= 0.3 ? 'no' : 'uncertain'
        evaluations[key] = {
          type: 'check',
          verdict,
          probability: prob,
        }
        overallScore += prob
      } else if (crit.type === 'classify') {
        const choice = typeof ansObj['choice'] === 'string' ? ansObj['choice'] : 'unknown'
        const conf = typeof ansObj['confidence'] === 'number' ? ansObj['confidence'] : 0
        evaluations[key] = {
          type: 'classify',
          choice,
          confidence: conf,
          probabilities: (ansObj['probabilities'] as Record<string, number>) ?? {},
        }
        overallScore += conf
      } else if (crit.type === 'score') {
        const scoreVal = String(ansObj['score'] ?? '1')
        const conf = typeof ansObj['confidence'] === 'number' ? ansObj['confidence'] : 0
        evaluations[key] = {
          type: 'score',
          score: scoreVal,
          confidence: conf,
        }
        overallScore += conf
      }
    }

    const normalizedScore = criteriaCount > 0 ? Number((overallScore / criteriaCount).toFixed(3)) : 0

    const meta = getFileMeta(map, filePath)
    const candidateEval: CandidateEvaluation = {
      file: filePath,
      score: normalizedScore,
      evaluations,
      astSummary: {
        exports: meta?.exports.map((e) => e.name) ?? [],
        dependencies: meta?.imports.map((i) => i.source) ?? [],
        keySignatures: astState.keySignatures,
      },
    }

    return candidateEval
  })

  const results = await Promise.all(evalPromises)
  for (const res of results) {
    if (res && res.score >= minConfidence) {
      evaluatedCandidates.push(res)
    }
  }

  // Sort descending by score
  evaluatedCandidates.sort((a, b) => b.score - a.score)

  const latencyMs = Math.round(performance.now() - start)

  return {
    intent: request.intent,
    matches: evaluatedCandidates,
    totalCandidatesEvaluated: candidateFiles.length,
    latencyMs,
  }
}
