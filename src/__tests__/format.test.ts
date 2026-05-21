// Refactored: 2026-05-21 — modern JS/TS
import { describe, expect, test } from 'bun:test'

import { formatDegraded, formatFound, formatNotFound, kindShort, serializeForLLM } from '../format.js'

import type { ExtractedSymbol, SymbolEntry } from '../types.js'

const baseExtraction: ExtractedSymbol = {
  candidate: { file: 'src/cache.ts', symbol: 'userCache', confidence: 0.9 },
  code: 'function userCache() {}',
  signature: 'function userCache()',
  doc: 'Cache users',
  imports: ['./types.js'],
  importedBy: ['src/index.ts'],
  extractionOk: true,
  startLine: 10,
  endLine: 20,
}

describe('kindShort', () => {
  test('maps every SymbolKind to a short token', () => {
    expect(kindShort('FunctionDeclaration')).toBe('fn')
    expect(kindShort('ClassDeclaration')).toBe('cls')
    expect(kindShort('MethodDefinition')).toBe('method')
    expect(kindShort('TSInterfaceDeclaration')).toBe('iface')
    expect(kindShort('TSTypeAliasDeclaration')).toBe('type')
    expect(kindShort('ArrowFunctionExpression')).toBe('fn')
  })
})

describe('formatFound', () => {
  test('renders header, doc, code, deps, used and line range', () => {
    const out = formatFound([baseExtraction])
    expect(out).toContain('[Scout: FOUND]')
    expect(out).toContain('## userCache (src/cache.ts:L10-20)')
    expect(out).toContain('/* Cache users */')
    expect(out).toContain('```ts')
    expect(out).toContain('Deps: ./types.js')
    expect(out).toContain('Used: src/index.ts')
  })

  test('flags failed extractions with warning sigil', () => {
    const out = formatFound([{ ...baseExtraction, extractionOk: false }])
    expect(out).toContain('⚠ Exact extraction failed')
  })

  test('injects git status when provided', () => {
    const out = formatFound([baseExtraction], new Map([['src/cache.ts', 'M']]))
    expect(out).toContain('Git: M')
  })
})

describe('formatNotFound', () => {
  test('reports empty-project case differently', () => {
    expect(formatNotFound('x', 0)).toContain('appears to be a new project')
    expect(formatNotFound('x', 42)).toContain('42 symbols')
  })
})

describe('formatDegraded', () => {
  test('always tells the caller it is safe to proceed', () => {
    const out = formatDegraded('boom')
    expect(out).toContain('[Scout: DEGRADED]')
    expect(out).toContain('safe — continue')
  })
})

describe('serializeForLLM', () => {
  const symbols: SymbolEntry[] = [
    { name: 'A', file: 'a.ts', line: 1, kind: 'FunctionDeclaration', signature: 'function A()', doc: '' },
    { name: 'B', file: 'a.ts', line: 2, kind: 'ClassDeclaration', signature: 'class B', doc: 'docs' },
    { name: 'C', file: 'b.ts', line: 3, kind: 'TSTypeAliasDeclaration', signature: 'type C = string', doc: '' },
  ]

  test('groups by file with `#` headers', () => {
    const out = serializeForLLM(symbols)
    expect(out).toMatch(/# a\.ts[\s\S]+# b\.ts/)
  })

  test('includes short kind labels and doc suffixes', () => {
    const out = serializeForLLM(symbols)
    expect(out).toContain('cls: class B — docs')
    expect(out).toContain('type: type C = string')
  })
})
