// Refactored: 2026-05-21 — modern JS/TS
import { describe, expect, test } from 'bun:test'

import { cleanJSON } from '../llm.js'

describe('cleanJSON', () => {
  test('strips ```json fences', () => {
    expect(cleanJSON('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  test('strips plain ``` fences', () => {
    expect(cleanJSON('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  test('falls back to first `{` / last `}` slice', () => {
    expect(cleanJSON('prelude {"a":1, "b":[1,2]} trailing junk')).toBe('{"a":1, "b":[1,2]}')
  })

  test('returns trimmed raw string when no JSON markers present', () => {
    expect(cleanJSON('  hello  ')).toBe('hello')
  })
})
