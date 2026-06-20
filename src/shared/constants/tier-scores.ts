import type { RelevanceTier } from '../types/index.js'

/** Numeric weight for each relevance tier. Higher = more important. */
export const TIER_SCORE: Record<RelevanceTier, number> = {
  mustRead: 4,
  likelyRelevant: 3,
  dependencyOnly: 2,
  testsOrExamples: 1,
  excluded: 0,
}
