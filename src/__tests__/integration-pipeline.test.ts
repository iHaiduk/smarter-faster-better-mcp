import { describe, expect, test, afterEach } from 'bun:test'
import { runFindCodePipeline, runGetFileContext, runTraceSymbolPipeline, runExplainContextPack } from '../pipeline/index.js'
import { runFindFiles } from '../pipeline/find-files.js'
import { resolveSecurePath } from '../pipeline/resolve-path.js'
import type { ScoutConfig } from '../shared/types/index.js'

const originalFetch = global.fetch

function mockFetchLlm(responseContent: string) {
  global.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: responseContent } }],
  }), { status: 200 }) as unknown as Response
}

function mockFetchFail(status: number) {
  global.fetch = async () => new Response(null, { status }) as unknown as Response
}

const ROOT = process.cwd()

describe('Integration: resolveSecurePath', () => {
  test('resolves a valid file', async () => {
    const result = await resolveSecurePath('package.json', ROOT)
    expect(result).toHaveProperty('realPath')
    expect((result as { realPath: string }).realPath).toContain('package.json')
  })

  test('rejects path traversal', async () => {
    const result = await resolveSecurePath('../../etc/passwd', ROOT)
    expect(result).toHaveProperty('error')
  })

  test('rejects nonexistent file', async () => {
    const result = await resolveSecurePath('nonexistent-file-xyz.ts', ROOT)
    expect(result).toHaveProperty('error')
  })

  test('rejects absolute path', async () => {
    const result = await resolveSecurePath('/etc/passwd', ROOT)
    expect(result).toHaveProperty('error')
  })
})

describe('Integration: runFindFiles', () => {
  test('finds files by glob pattern', async () => {
    const result = await runFindFiles('*.json', ROOT)
    expect(result).toContain('package.json')
    expect(result).toContain('Found')
  })

  test('finds TypeScript files', async () => {
    const result = await runFindFiles('src/**/*.ts', ROOT)
    expect(result).toContain('index.ts')
  })

  test('returns empty for non-matching pattern', async () => {
    const result = await runFindFiles('*.nonexistent-ext', ROOT)
    expect(result).toContain('Found 0 files')
  })
})

describe('Integration: runGetFileContext', () => {
  afterEach(() => { global.fetch = originalFetch })

  test('reads full file and applies LLM filtering', async () => {
    mockFetchLlm(JSON.stringify({
      relevanceScore: 0.85,
      contextualExplanation: 'JSON utility module',
      relevantContent: 'export function cleanJSON',
    }))
    const result = await runGetFileContext('src/shared/utils/json.ts')
    expect(result).toContain('cleanJSON')
  })

  test('falls back to raw content when LLM fails', async () => {
    mockFetchFail(500)
    const result = await runGetFileContext('src/shared/utils/json.ts')
    expect(result).toContain('cleanJSON')
  })

  test('rejects path traversal', async () => {
    const result = await runGetFileContext('../../etc/passwd')
    expect(result).toContain('Access denied')
  })

  test('handles nonexistent file', async () => {
    const result = await runGetFileContext('nonexistent.ts')
    expect(result).toContain('File not found')
  })
})

describe('Integration: runTraceSymbolPipeline', () => {
  afterEach(() => { global.fetch = originalFetch })

  test('traces an existing symbol', async () => {
    mockFetchLlm(JSON.stringify([]))
    const result = await runTraceSymbolPipeline('cleanJSON', 'src/shared/utils/json.ts')
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  test('handles unknown symbol gracefully', async () => {
    mockFetchLlm(JSON.stringify([]))
    const result = await runTraceSymbolPipeline('nonexistentSymbolXYZ')
    expect(typeof result).toBe('string')
  })
})

describe('Integration: runFindCodePipeline', () => {
  afterEach(() => { global.fetch = originalFetch })

  test('searches for code by task description', async () => {
    mockFetchLlm(JSON.stringify([
      { file: 'src/shared/utils/json.ts', symbol: 'cleanJSON', confidence: 0.9, tier: 'mustRead' },
    ]))
    const config: ScoutConfig = {
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'lm-studio',
      model: 'gpt-oss-20b',
      llmTimeoutMs: 5000,
      llmParallelism: 1,
      parser: 'oxc',
    }
    const result = await runFindCodePipeline('cleanJSON function', config, false, ROOT)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('Integration: runExplainContextPack', () => {
  afterEach(() => { global.fetch = originalFetch })

  test('generates context pack for a task', async () => {
    mockFetchLlm(JSON.stringify([
      { file: 'src/shared/utils/json.ts', symbol: 'cleanJSON', confidence: 0.8, tier: 'likelyRelevant' },
    ]))
    const config: ScoutConfig = {
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'lm-studio',
      model: 'gpt-oss-20b',
      llmTimeoutMs: 5000,
      llmParallelism: 1,
      parser: 'oxc',
    }
    const result = await runExplainContextPack('refactor the JSON cleaning utility', config, ROOT)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})
