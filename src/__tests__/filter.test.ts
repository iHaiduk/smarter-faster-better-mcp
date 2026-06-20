// Refactored: 2026-05-21 — modern JS/TS
import { describe, expect, test } from 'bun:test'

import { filterMap, getEditDistance } from '../extraction/matcher/filter.js'

import type { ProjectMap } from '../shared/types/index.js'

const sample: ProjectMap = {
  generatedAt: 0,
  symbolsCount: 4,
  symbols: [
    {
      name: 'userCache',
      file: 'src/cache.ts',
      line: 1,
      kind: 'FunctionDeclaration',
      signature: 'function userCache()',
      doc: 'L1 cache for users',
    },
    {
      name: 'parseFile',
      file: 'src/parser.ts',
      line: 1,
      kind: 'FunctionDeclaration',
      signature: 'function parseFile()',
      doc: '',
    },
    {
      name: 'TSConfig',
      file: 'src/types.ts',
      line: 1,
      kind: 'TSInterfaceDeclaration',
      signature: 'interface TSConfig',
      doc: '',
    },
    {
      name: 'totallyUnrelated',
      file: 'src/misc.ts',
      line: 1,
      kind: 'FunctionDeclaration',
      signature: 'function totallyUnrelated()',
      doc: '',
    },
  ],
}

describe('getEditDistance', () => {
  test('returns 0 for identical strings', () => {
    expect(getEditDistance('cache', 'cache')).toBe(0)
  })

  test('counts insertions/deletions/substitutions', () => {
    expect(getEditDistance('cache', 'caches')).toBe(1)
    expect(getEditDistance('cache', 'cake')).toBe(2)
    expect(getEditDistance('', 'abc')).toBe(3)
    expect(getEditDistance('abc', '')).toBe(3)
  })
})

describe('filterMap', () => {
  test('returns top-K when task has no actionable keywords', () => {
    const result = filterMap(sample, 'the a an of')
    expect(result.length).toBe(sample.symbols.length)
  })

  test('exact substring match wins over unrelated entries', () => {
    const result = filterMap(sample, 'parse file from disk')
    expect(result[0]?.name).toBe('parseFile')
  })

  test('finds symbols via doc/signature/file haystack', () => {
    const result = filterMap(sample, 'user cache')
    expect(result.map((s) => s.name)).toContain('userCache')
  })

  test('drops irrelevant symbols when at least one keyword matches', () => {
    const result = filterMap(sample, 'parse')
    expect(result.map((s) => s.name)).not.toContain('totallyUnrelated')
  })
})
