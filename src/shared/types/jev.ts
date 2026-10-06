export type JevAction = 'act' | 'review' | 'abstain'
export type JevVerdict = 'yes' | 'no' | 'uncertain'

export interface JevClassifyResponse {
  readonly choice: string
  readonly confidence: number
  readonly probabilities: Record<string, number>
  readonly action?: JevAction
  readonly model?: string
  readonly usage?: {
    readonly input_tokens: number
    readonly output_tokens: number
  }
  readonly latency_ms?: number
}

export interface JevCheckResponse {
  readonly verdict: JevVerdict
  readonly probability_yes: number
  readonly model?: string
  readonly usage?: {
    readonly input_tokens: number
    readonly output_tokens: number
  }
  readonly latency_ms?: number
}

export interface JevScoreResponse {
  readonly score: string
  readonly confidence: number
  readonly distribution: Record<string, number>
  readonly model?: string
  readonly usage?: {
    readonly input_tokens: number
    readonly output_tokens: number
  }
  readonly latency_ms?: number
}

export type DynamicCriterionType = 'check' | 'classify' | 'score'

export interface DynamicCriterionCheck {
  readonly type: 'check'
  readonly question: string
  readonly yesMeans?: string
  readonly noMeans?: string
}

export interface DynamicCriterionClassify {
  readonly type: 'classify'
  readonly question: string
  readonly options: Record<string, string>
  readonly actAbove?: number
}

export interface DynamicCriterionScore {
  readonly type: 'score'
  readonly criterion: string
  readonly levels: Record<string, string>
}

export type DynamicCriterion =
  | DynamicCriterionCheck
  | DynamicCriterionClassify
  | DynamicCriterionScore

export interface DynamicTriageRequest {
  readonly intent: string
  readonly searchHints?: readonly string[]
  readonly candidateFiles?: readonly string[]
  readonly criteria: Record<string, DynamicCriterion>
  readonly minConfidence?: number
  readonly limit?: number
  readonly workspaceRoot?: string
}

export interface CandidateEvaluation {
  readonly file: string
  readonly score: number
  readonly evaluations: Record<
    string,
    | { readonly type: 'check'; readonly verdict: JevVerdict; readonly probability: number }
    | { readonly type: 'classify'; readonly choice: string; readonly confidence: number; readonly probabilities: Record<string, number> }
    | { readonly type: 'score'; readonly score: string; readonly confidence: number }
  >
  readonly astSummary: {
    readonly exports: readonly string[]
    readonly dependencies: readonly string[]
    readonly loc?: number
    readonly keySignatures?: readonly string[]
  }
}

export interface DynamicTriageResponse {
  readonly intent: string
  readonly matches: readonly CandidateEvaluation[]
  readonly totalCandidatesEvaluated: number
  readonly latencyMs: number
}
