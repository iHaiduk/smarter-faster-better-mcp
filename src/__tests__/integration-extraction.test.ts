import { describe, expect, test } from 'bun:test'
import { extractWithOxc } from '../extraction/extract.js'
import { filterMap, getDeterministicMatches } from '../extraction/matcher/filter.js'
import { findDeps } from '../dependency-resolver/deps.js'
import { globToRegex, matchGlob, normalizePath } from '../shared/utils/glob.js'
import { buildEndpoint } from '../shared/utils/llm-client.js'
import { cleanJSON } from '../shared/utils/json.js'
import { shouldIgnorePath } from '../shared/constants/ignore-rules.js'
import type { ProjectMap, SymbolKind } from '../shared/types/index.js'

const FN_KIND: SymbolKind = 'FunctionDeclaration'

describe('Integration: OXC Extraction', () => {
  test('extracts symbols from a known file', async () => {
    const map: ProjectMap = {
      symbols: [{ name: 'cleanJSON', kind: FN_KIND, line: 2, file: 'src/shared/utils/json.ts', signature: 'function cleanJSON', doc: '' }],
      files: [],
      symbolsCount: 1,
      generatedAt: 0,
    }
    const result = await extractWithOxc(
      { file: 'src/shared/utils/json.ts', symbol: 'cleanJSON', confidence: 0.9 },
      map,
    )
    expect(result).toBeDefined()
    expect(result.extractionOk).toBe(true)
  })

  test('handles nonexistent file gracefully', async () => {
    const map: ProjectMap = {
      symbols: [{ name: 'foo', kind: FN_KIND, line: 1, file: 'nonexistent-file.ts', signature: '', doc: '' }],
      files: [],
      symbolsCount: 1,
      generatedAt: 0,
    }
    const result = await extractWithOxc(
      { file: 'nonexistent-file.ts', symbol: 'foo', confidence: 0.5 },
      map,
    )
    expect(result.extractionOk).toBe(false)
  })
})

describe('Integration: Deterministic Matching', () => {
  test('finds exact symbol match', () => {
    const map: ProjectMap = {
      symbols: [
        { name: 'cleanJSON', kind: FN_KIND, line: 1, file: 'src/shared/utils/json.ts', signature: 'function cleanJSON', doc: '' },
        { name: 'buildEndpoint', kind: FN_KIND, line: 1, file: 'src/shared/utils/llm-client.ts', signature: 'function buildEndpoint', doc: '' },
      ],
      files: [],
      symbolsCount: 2,
      generatedAt: 0,
    }
    const matches = getDeterministicMatches(map, 'cleanJSON', false)
    expect(matches.length).toBe(1)
    expect(matches[0]!.symbol).toBe('cleanJSON')
  })

  test('returns empty for non-matching query', () => {
    const map: ProjectMap = {
      symbols: [
        { name: 'cleanJSON', kind: FN_KIND, line: 1, file: 'src/shared/utils/json.ts', signature: '', doc: '' },
      ],
      files: [],
      symbolsCount: 1,
      generatedAt: 0,
    }
    const matches = getDeterministicMatches(map, 'xyzNonexistent', false)
    expect(matches.length).toBe(0)
  })
})

describe('Integration: Dependency Resolution', () => {
  test('finds importers of a known symbol', async () => {
    const map: ProjectMap = {
      symbols: [],
      files: [
        { file: 'a.ts', imports: [{ source: './b.js', resolved: 'b.ts', specifiers: [{ local: 'foo', imported: 'foo' }] }], exports: [], reExports: [], declarations: [] },
        { file: 'b.ts', imports: [], exports: [{ name: 'foo', local: 'foo' }], reExports: [], declarations: [] },
      ],
      symbolsCount: 0,
      generatedAt: 0,
    }
    const deps = await findDeps('foo', 'b.ts', map)
    expect(deps).toContain('a.ts')
  })

  test('returns empty for unknown symbol', async () => {
    const deps = await findDeps('nonexistentSymbol', 'src/index.ts')
    expect(deps).toEqual([])
  })
})

describe('Integration: Shared Utilities', () => {
  test('globToRegex matches expected patterns', () => {
    const regex = globToRegex('*.ts')
    expect(regex.test('index.ts')).toBe(true)
    expect(regex.test('index.js')).toBe(false)
  })

  test('globToRegex handles ** patterns', () => {
    const regex = globToRegex('src/**/*.ts')
    expect(regex.test('src/index.ts')).toBe(true)
    expect(regex.test('src/utils/helper.ts')).toBe(true)
    expect(regex.test('lib/index.ts')).toBe(false)
  })

  test('matchGlob supports matchBase (no slashes in pattern matches basename recursively)', () => {
    expect(matchGlob('src/utils/helper.ts', '*.ts')).toBe(true)
    expect(matchGlob('src/components/chat/ChatBubble.tsx', '*chat*')).toBe(true)
    expect(matchGlob('chat.ts', '*chat*')).toBe(true)
    expect(matchGlob('src/chat/foo.ts', 'foo.ts')).toBe(true)
    expect(matchGlob('src/chat/foo.ts', 'src/*.ts')).toBe(false) // has slash, so direct match only
    expect(matchGlob('src/foo.ts', 'src/*.ts')).toBe(true)
  })

  test('normalizePath converts backslashes', () => {
    expect(normalizePath('src\\utils\\file.ts')).toBe('src/utils/file.ts')
  })

  test('buildEndpoint creates correct URL', () => {
    const url = buildEndpoint('http://localhost:1234/v1')
    expect(url.toString()).toBe('http://localhost:1234/v1/chat/completions')
  })

  test('buildEndpoint handles trailing slash', () => {
    const url = buildEndpoint('http://localhost:1234/v1/')
    expect(url.toString()).toBe('http://localhost:1234/v1/chat/completions')
  })

  test('cleanJSON extracts JSON from markdown fences', () => {
    const result = cleanJSON('```json\n{"key": "value"}\n```')
    expect(JSON.parse(result)).toEqual({ key: 'value' })
  })

  test('shouldIgnorePath filters node_modules', () => {
    expect(shouldIgnorePath('node_modules/pkg/index.ts')).toBe(true)
  })

  test('shouldIgnorePath allows source files', () => {
    expect(shouldIgnorePath('src/index.ts')).toBe(false)
  })
})

describe('Integration: Filter Logic', () => {
  test('filterMap ranks relevant symbols higher', () => {
    const map: ProjectMap = {
      symbols: [
        { name: 'cleanJSON', kind: FN_KIND, line: 1, file: 'json.ts', signature: 'strip markdown fences', doc: '' },
        { name: 'unrelated', kind: 'ArrowFunctionExpression' as SymbolKind, line: 1, file: 'other.ts', signature: 'some other thing', doc: '' },
      ],
      files: [],
      symbolsCount: 2,
      generatedAt: 0,
    }
    const result = filterMap(map, 'cleanJSON markdown')
    expect(result.length).toBeGreaterThan(0)
    expect(result[0]!.name).toBe('cleanJSON')
  })
})
