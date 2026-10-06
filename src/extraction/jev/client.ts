import { TypeSafeClient, choice, noul, score, type Question } from '@typesafe-ai/sdk'

import type {
  DynamicCriterion,
  JevCheckResponse,
  JevClassifyResponse,
  JevScoreResponse,
  ScoutConfig,
} from '../../shared/types/index.js'

let cachedClient: TypeSafeClient | null = null
let cachedApiKey: string | null = null

/** Returns an initialized TypeSafeClient instance or null if no API key is configured. */
export function getTypeSafeClient(config?: ScoutConfig): TypeSafeClient | null {
  const apiKey =
    config?.jevApiKey ??
    process.env['JEV_API_KEY'] ??
    process.env['TYPESAFE_API_KEY'] ??
    null

  if (!apiKey) return null

  if (cachedClient && cachedApiKey === apiKey) {
    return cachedClient
  }

  const customBaseUrl = config?.jevBaseUrl ?? process.env['JEV_BASE_URL']

  cachedClient = new TypeSafeClient({
    apiKey,
    baseURL: customBaseUrl || undefined,
  })
  cachedApiKey = apiKey

  return cachedClient
}

/** Check if Jev System-1 is configured and available. */
export function isJevAvailable(config?: ScoutConfig): boolean {
  return getTypeSafeClient(config) !== null
}

export interface JevClassifyOptions {
  readonly state: unknown
  readonly question: string
  readonly options: Record<string, string>
  readonly actAbove?: number
}

/** Runs a typed classification using Jev. */
export async function runJevClassify(
  opts: JevClassifyOptions,
  config?: ScoutConfig,
): Promise<JevClassifyResponse | null> {
  const client = getTypeSafeClient(config)
  if (!client) return null

  try {
    const start = performance.now()
    const response = await client.systemOne({
      state: opts.state as string,
      questions: {
        cls: choice(opts.question, opts.options),
      },
    })
    const latencyMs = Math.round(performance.now() - start)

    const ans = response.answers.cls
    const choiceKey = ans.choice
    const confidence = ans.confidence
    const probabilities = ans.probabilities as Record<string, number>

    const actThreshold = opts.actAbove ?? 0.8
    const action = confidence >= actThreshold ? 'act' : confidence >= 0.5 ? 'review' : 'abstain'

    return {
      choice: choiceKey,
      confidence,
      probabilities,
      action,
      model: response.model,
      usage: response.usage,
      latency_ms: latencyMs,
    }
  } catch (err) {
    console.error('[Scout/Jev] classify error:', err)
    return null
  }
}

export interface JevCheckOptions {
  readonly state: unknown
  readonly question: string
  readonly yesMeans?: string
  readonly noMeans?: string
  readonly yesAtOrAbove?: number
}

/** Runs a fast binary yes/no check using Jev. */
export async function runJevCheck(
  opts: JevCheckOptions,
  config?: ScoutConfig,
): Promise<JevCheckResponse | null> {
  const client = getTypeSafeClient(config)
  if (!client) return null

  try {
    const start = performance.now()
    const response = await client.systemOne({
      state: opts.state as string,
      questions: {
        chk: noul(opts.question, {
          true: opts.yesMeans ?? 'Yes, condition is met',
          false: opts.noMeans ?? 'No, condition is not met',
        }),
      },
    })
    const latencyMs = Math.round(performance.now() - start)

    const ans = response.answers.chk
    const probYes = ans.noul
    const yesThreshold = opts.yesAtOrAbove ?? 0.7
    const verdict = probYes >= yesThreshold ? 'yes' : probYes <= 0.3 ? 'no' : 'uncertain'

    return {
      verdict,
      probability_yes: probYes,
      model: response.model,
      usage: response.usage,
      latency_ms: latencyMs,
    }
  } catch (err) {
    console.error('[Scout/Jev] check error:', err)
    return null
  }
}

export interface JevScoreOptions {
  readonly state: unknown
  readonly criterion: string
  readonly levels: Record<string, string>
  readonly actAbove?: number
}

/** Runs a calibrated scoring evaluation using Jev. */
export async function runJevScore(
  opts: JevScoreOptions,
  config?: ScoutConfig,
): Promise<JevScoreResponse | null> {
  const client = getTypeSafeClient(config)
  if (!client) return null

  try {
    const start = performance.now()
    const levelEntries = Object.values(opts.levels)
    const response = await client.systemOne({
      state: opts.state as string,
      questions: {
        scr: score(opts.criterion, levelEntries as unknown as [string, string, ...string[]]),
      },
    })
    const latencyMs = Math.round(performance.now() - start)

    const ans = response.answers.scr
    const scoreVal = String(ans.score)
    const confidence = ans.confidence
    const distribution = ans.probabilities as Record<string, number>

    return {
      score: scoreVal,
      confidence,
      distribution,
      model: response.model,
      usage: response.usage,
      latency_ms: latencyMs,
    }
  } catch (err) {
    console.error('[Scout/Jev] score error:', err)
    return null
  }
}

/** Evaluates an entire set of dynamic criteria in ONE single request to TypeSafe Jev. */
export async function evaluateDynamicCriteriaBatch(
  state: unknown,
  criteria: Record<string, DynamicCriterion>,
  config?: ScoutConfig,
) {
  const client = getTypeSafeClient(config)
  if (!client) return null

  try {
    const questionsObj: Record<string, Question> = {}

    for (const [key, crit] of Object.entries(criteria)) {
      if (crit.type === 'check') {
        questionsObj[key] = noul(crit.question, {
          true: crit.yesMeans ?? 'Yes, condition is met',
          false: crit.noMeans ?? 'No, condition is not met',
        })
      } else if (crit.type === 'classify') {
        questionsObj[key] = choice(crit.question, crit.options)
      } else if (crit.type === 'score') {
        const levels = Object.values(crit.levels)
        questionsObj[key] = score(crit.criterion, levels as unknown as [string, string, ...string[]])
      }
    }

    const start = performance.now()
    const response = await client.systemOne({
      state: state as string,
      questions: questionsObj,
    })
    const latencyMs = Math.round(performance.now() - start)

    return {
      answers: response.answers,
      model: response.model,
      usage: response.usage,
      latencyMs,
    }
  } catch (err) {
    console.error('[Scout/Jev] evaluateDynamicCriteriaBatch error:', err)
    return null
  }
}
