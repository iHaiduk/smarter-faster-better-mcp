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
    const query = '"cleanJSON" in src/extraction/llm.ts'
    
    const result = await runFindCodePipeline(query, mockConfig, false, root)
    const parsed = JSON.parse(result)
    
    expect(parsed).toHaveProperty('markdown')
    expect(parsed).toHaveProperty('structuredContent')
    expect(parsed.markdown).toContain('[Scout: FOUND]')
    expect(parsed.markdown).toContain('## Match@L')
    expect(parsed.markdown).toContain('src/extraction/llm.ts')
    expect(parsed.markdown).toContain('cleanJSON')

    const structured = parsed.structuredContent
    expect(structured.symbols).toContain('src/extraction/llm.ts|Match@L')
    expect(structured.confidence).toBe(1.0)
    expect(structured.reason).toBe('Keyword/regex search matching "cleanJSON" in "src/extraction/llm.ts"')
  })

  test('returns empty results if no match is found for search query', async () => {
    const root = path.resolve(import.meta.dir, '../..')
    const query = '"nonExistentWordInCodebaseBlaBla" in src/llm.ts'

    const result = await runFindCodePipeline(query, mockConfig, false, root)
    const parsed = JSON.parse(result)

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
    const result = await runFindCodePipeline('"function" in src/llm.ts', mockConfig, false, root)
    const parsed = JSON.parse(result)
    const lines = parsed.structuredContent.symbols.split('\n').slice(1).filter(Boolean)
    const symbolNames = lines.map((l: string) => l.split('|').slice(0, 2).join('|'))
    const unique = new Set(symbolNames)
    expect(unique.size).toBe(symbolNames.length)
  })
})
