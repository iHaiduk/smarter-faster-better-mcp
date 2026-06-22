// Refactored: 2026-05-21 — modern JS/TS
import { describe, expect, test } from 'bun:test'

import { formatDegraded, formatFound, formatNotFound, kindShort, serializeForLLM, toStructuredJSON } from '../bundle/formatter/format.js'

import type { ExtractedSymbol, SymbolEntry } from '../shared/types/index.js'

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
  test('renders header, doc, code, used and line range', () => {
    const out = formatFound([baseExtraction])
    expect(out).toContain('[Scout: FOUND]')
    expect(out).toContain('## userCache (src/cache.ts:L10-20)')
    expect(out).toContain('/* Cache users */')
    expect(out).toContain('```ts')
    expect(out).toContain('Used: src/index.ts')
  })

  test('flags failed extractions with warning sigil', () => {
    const out = formatFound([{ ...baseExtraction, extractionOk: false }])
    expect(out).toContain('⚠ AST fallback')
  })

  test('omits git status even when provided', () => {
    const out = formatFound([baseExtraction], new Map([['src/cache.ts', 'M']]))
    expect(out).not.toContain('Git: M')
  })

  test('omits mustRead tier label but keeps non-default tiers', () => {
    const mustRead = formatFound([{ ...baseExtraction, relevanceTier: 'mustRead' }])
    const dependencyOnly = formatFound([{ ...baseExtraction, relevanceTier: 'dependencyOnly' }])

    expect(mustRead).not.toContain('[Tier: mustRead]')
    expect(dependencyOnly).toContain('[Tier: dependencyOnly]')
  })

  test('outputs signature instead of full code for non-mustRead tiers', () => {
    const out = formatFound([{ ...baseExtraction, relevanceTier: 'likelyRelevant' }])
    expect(out).toContain(baseExtraction.signature)
    expect(out).not.toContain(baseExtraction.code)
  })

  test('does not inline associated types in markdown output', () => {
    const out = formatFound([{ ...baseExtraction, typeDefs: ['type:X\ninterface X {}'] }])
    expect(out).not.toContain('**Associated Types:**')
    expect(out).not.toContain('interface X')
  })
})

describe('formatNotFound', () => {
  test('reports empty-project case differently', () => {
    expect(formatNotFound('x', 0)).toContain('consider running refresh_map')
    expect(formatNotFound('x', 42)).toContain('42 indexed symbols')
  })
})

describe('formatDegraded', () => {
  test('tells the caller to retry before filesystem fallback', () => {
    const out = formatDegraded('boom')
    expect(out).toContain('[Scout: DEGRADED]')
    expect(out).toContain('Retry find_code once')
    expect(out).toContain('after two failed or degraded Scout attempts')
  })
})

describe('serializeForLLM', () => {
  const symbols: SymbolEntry[] = [
    { name: 'A', file: 'a.ts', line: 1, kind: 'FunctionDeclaration', signature: 'function A()', doc: '' },
    { name: 'B', file: 'a.ts', line: 2, kind: 'ClassDeclaration', signature: 'class B', doc: 'docs' },
    { name: 'C', file: 'b.ts', line: 3, kind: 'TSTypeAliasDeclaration', signature: 'type C = string', doc: '' },
  ]

  test('groups by file with `File:` headers', () => {
    const out = serializeForLLM(symbols)
    expect(out).toMatch(/File: a\.ts[\s\S]+File: b\.ts/)
  })

  test('includes short kind labels and doc suffixes', () => {
    const out = serializeForLLM(symbols)
    expect(out).toContain('cls: class B — docs')
    expect(out).toContain('type: type C = string')
  })
})

describe('toStructuredJSON', () => {
  test('compacts structured symbols into tabular format and comma-separated deps list', () => {
    const out = toStructuredJSON('md', [{ ...baseExtraction, typeDefs: ['type:X'], relevanceTier: 'mustRead' }], 0.9, 'why')
    const parsed = JSON.parse(out) as {
      markdown: string
      structuredContent: {
        symbols: string
        deps: string
        confidence: number
        reason: string
      }
    }

    expect(parsed.markdown).toBe('md')
    expect(parsed.structuredContent.symbols).toContain('file|symbol|lines|tier|status')
    expect(parsed.structuredContent.symbols).toContain('src/cache.ts|userCache|10-20|mustRead|ok')
    expect(parsed.structuredContent.deps).toContain('./types.js')
    expect(parsed.structuredContent.deps).toContain('src/index.ts')
    expect(parsed.structuredContent.confidence).toBe(0.9)
    expect(parsed.structuredContent.reason).toBe('why')
  })

  test('resolves exact dependency lines when ProjectMap is provided and imports are used', () => {
    const mockMap = {
      generatedAt: Date.now(),
      symbolsCount: 1,
      symbols: [
        {
          name: 'SymbolA',
          file: 'src/dep.ts',
          line: 42,
          kind: 'FunctionDeclaration' as const,
          signature: 'export function SymbolA()',
          doc: 'Do A',
        },
      ],
      files: [
        {
          file: 'src/cache.ts',
          imports: [
            {
              source: './dep.js',
              resolved: 'src/dep.ts',
              specifiers: [
                {
                  local: 'SymbolA',
                  imported: 'SymbolA',
                },
              ],
            },
          ],
          exports: [],
          reExports: [],
          declarations: [],
        },
      ],
    }

    const extractionWithImportUse: ExtractedSymbol = {
      ...baseExtraction,
      code: 'function userCache() { SymbolA(); }',
    }

    const out = toStructuredJSON(
      'md',
      [extractionWithImportUse],
      0.9,
      'why',
      [],
      [],
      mockMap,
    )
    const parsed = JSON.parse(out)

    expect(parsed.structuredContent.deps).toBe('src/dep.ts[42]')
  })
})
