import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import { runFindCodePipeline } from '../pipeline/index.js'
import type { ScoutConfig } from '../shared/types/index.js'

const mockConfig: ScoutConfig = {
  baseUrl: 'http://localhost:1234/v1',
  apiKey: 'lm-studio',
  model: 'openai/gpt-oss-20b',
  llmTimeoutMs: 1000,
  llmParallelism: 1,
  parser: 'oxc',
}

describe('runFindCodePipeline with Custom Search', () => {
  test('successfully performs custom regex/word search on project files', async () => {
    const root = path.resolve(import.meta.dir, '../..')
    const query = '"cleanJSON" in src/shared/utils/json.ts'
    
    const parsed = await runFindCodePipeline(query, mockConfig, false, root)
    
    expect(parsed).toHaveProperty('markdown')
    expect(parsed).toHaveProperty('structuredContent')
    expect(parsed.markdown).toContain('[Scout: FOUND]')
    expect(parsed.markdown).toContain('## Match@L')
    expect(parsed.markdown).toContain('src/shared/utils/json.ts')
    expect(parsed.markdown).toContain('cleanJSON')

    const structured = parsed.structuredContent
    expect(structured.symbols).toContain('src/shared/utils/json.ts|Match@L')
    expect(structured.confidence).toBe(1.0)
    expect(structured.reason).toBe('Keyword/regex search matching "cleanJSON" in "src/shared/utils/json.ts"')
  })

  test('returns empty results if no match is found for search query', async () => {
    const root = path.resolve(import.meta.dir, '../..')
    const query = '"nonExistentWordInCodebaseBlaBla" in src/shared/utils/json.ts'

    const parsed = await runFindCodePipeline(query, mockConfig, false, root)

    expect(parsed.markdown).toContain('[Scout: FOUND]') // formatFound with empty list
    expect(parsed.structuredContent.symbols).toBe('file|symbol|lines|tier|status')
  })

  test('rejects path-traversal globs at parse time', async () => {
    const { parseCustomQuery } = await import('../extraction/custom-search/searcher.js')
    expect(parseCustomQuery('"foo" in ../../**/*.ts')).toBeNull()
    expect(parseCustomQuery('"foo" in /etc/*')).toBeNull()
    expect(parseCustomQuery('"foo" in ~/secrets/*')).toBeNull()
    expect(parseCustomQuery('"foo" in src/a/../../etc/*')).toBeNull()
    expect(parseCustomQuery('"foo" in src/**/*.ts')).not.toBeNull()
  })

  test('rejects overly long patterns at parse time', async () => {
    const { parseCustomQuery } = await import('../extraction/custom-search/searcher.js')
    const longPattern = 'a'.repeat(201)
    expect(parseCustomQuery(`"${longPattern}" in src/**/*.ts`)).toBeNull()
  })

  test('produces unique symbol names per match block', async () => {
    const root = path.resolve(import.meta.dir, '../..')
    const parsed = await runFindCodePipeline('"function" in src/llm.ts', mockConfig, false, root)
    const lines = parsed.structuredContent.symbols.split('\n').slice(1).filter(Boolean)
    const symbolNames = lines.map((l: string) => l.split('|').slice(0, 2).join('|'))
    const unique = new Set(symbolNames)
    expect(unique.size).toBe(symbolNames.length)
  })
})

describe('one-call scout pipeline enhancements (WU3)', () => {
  const root = path.resolve(import.meta.dir, '../..')

  test('Jev-off fallback returns candidates with degraded indicator', async () => {
    // Config without Jev credentials
    const noJevConfig: ScoutConfig = {
      ...mockConfig,
      jevApiKey: undefined,
    }
    // Delete env key temporarily if present
    const prevKey = process.env['JEV_API_KEY']
    const prevTsKey = process.env['TYPESAFE_API_KEY']
    try {
      delete process.env['JEV_API_KEY']
      delete process.env['TYPESAFE_API_KEY']

      const res = await runFindCodePipeline('where are MCP tools registered', noJevConfig, false, root)
      expect(res).toHaveProperty('markdown')
      expect(res).toHaveProperty('structuredContent')
      expect(res.markdown).toContain('[Scout: FOUND]')
      expect(res.markdown).toContain('registerAllTools')
    } finally {
      if (prevKey) process.env['JEV_API_KEY'] = prevKey
      if (prevTsKey) process.env['TYPESAFE_API_KEY'] = prevTsKey
    }
  })

  test('zero-match outline fallback renders outlines when no symbol matches query identifiers', async () => {
    // Query that matches a file conceptually or coarsely, but has unusual identifiers
    const res = await runFindCodePipeline('nonexistentFunctionIdentifierXYZ in registerTools', mockConfig, false, root)
    expect(res).toHaveProperty('markdown')
    expect(res.markdown).toContain('[Scout: FOUND]')
  })

  test('stale-file refresh updates symbols if file mtime is newer than map generation', async () => {
    const { readMap } = await import('../cache/map-cache.js')
    const map = await readMap(root)
    const targetFile = 'src/shared/constants/budget.ts'
    const absPath = path.resolve(root, targetFile)

    // Artificially set map generatedAt to past
    const pastMap = { ...map, generatedAt: Date.now() - 10000 }
    const { ensureFileFreshness } = await import('../pipeline/index.js')
    // Touch mtime of target file
    const now = new Date()
    await import('node:fs/promises').then((fs) => fs.utimes(absPath, now, now))

    const refreshed = await ensureFileFreshness(targetFile, pastMap, root)
    expect(refreshed).toBe(true)
  })
})
