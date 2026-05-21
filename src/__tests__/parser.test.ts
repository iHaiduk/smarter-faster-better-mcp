// Refactored: 2026-05-21 — modern JS/TS
import { describe, expect, test } from 'bun:test'

import { extractJSDoc } from '../parser.js'

describe('extractJSDoc', () => {
  test('extracts JSDoc immediately preceding a symbol', () => {
    const source = '/**\n * Hello world\n * second line\n */\nfunction x() {}'
    const offset = source.indexOf('function')
    expect(extractJSDoc(source, offset)).toBe('Hello world second line')
  })

  test('returns empty string when there is no preceding JSDoc', () => {
    const source = '// regular comment\nfunction x() {}'
    const offset = source.indexOf('function')
    expect(extractJSDoc(source, offset)).toBe('')
  })

  test('truncates long JSDoc to 300 chars', () => {
    const big = `/**\n * ${'x'.repeat(400)}\n */\nfunction x() {}`
    const offset = big.indexOf('function')
    expect(extractJSDoc(big, offset).length).toBe(300)
  })
})
