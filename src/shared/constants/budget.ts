import type { ContextBudgetOptions } from '../types/index.js'

export const DEFAULT_BUDGET = {
  maxFiles: 5,
  maxSymbols: 10,
  maxChars: 20_000,
  includeTests: false,
} as const satisfies Required<ContextBudgetOptions>

/** Fills in any missing budget fields with defaults. */
export function resolveBudget(input?: ContextBudgetOptions): Required<ContextBudgetOptions> {
  return {
    maxFiles: input?.maxFiles ?? DEFAULT_BUDGET.maxFiles,
    maxSymbols: input?.maxSymbols ?? DEFAULT_BUDGET.maxSymbols,
    maxChars: input?.maxChars ?? DEFAULT_BUDGET.maxChars,
    includeTests: input?.includeTests ?? DEFAULT_BUDGET.includeTests,
  }
}
