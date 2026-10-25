import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import { runMeasurements, GOLDEN_SET } from '../../scripts/measure-golden.js'

describe('Golden Set Baseline & Quality Regression', () => {
  test('golden set questions are well-formed and non-empty', () => {
    expect(GOLDEN_SET.length).toBe(10)
    for (const q of GOLDEN_SET) {
      expect(q.question.length).toBeGreaterThan(5)
      expect(q.expectedFile.startsWith('src/')).toBe(true)
      expect(q.expectedSymbol.length).toBeGreaterThan(2)
    }
  })

  test('runs golden set evaluation and captures baseline stats', async () => {
    const root = path.resolve(import.meta.dir, '../..')
    const stats = await runMeasurements(root)

    expect(stats.total).toBe(10)
    expect(stats.results.length).toBe(10)
    expect(stats.medianChars).toBeGreaterThan(0)
    expect(stats.p95LatencyMs).toBeGreaterThan(0)
  }, 30_000)
})
