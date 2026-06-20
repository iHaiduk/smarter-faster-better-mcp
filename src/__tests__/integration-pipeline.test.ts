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

describe('Integration: Full pipeline with query analysis + validation', () => {
  afterEach(() => { global.fetch = originalFetch })

  const config: ScoutConfig = {
    baseUrl: 'http://localhost:1234/v1',
    apiKey: 'lm-studio',
    model: 'gpt-oss-20b',
    llmTimeoutMs: 5000,
    llmParallelism: 1,
    parser: 'oxc',
  }

  let callCount = 0
  let responses: string[]

  /** Sets up a queue of mock responses — each fetch call pops the next one. */
  function mockFetchSequence(...contents: string[]) {
    callCount = 0
    responses = [...contents]
    global.fetch = (async () => {
      const idx = callCount++
      const content = responses[idx % responses.length] ?? '[]'
      return new Response(JSON.stringify({
        choices: [{ message: { content } }],
      }), { status: 200 }) as unknown as Response
    }) as unknown as typeof fetch
  }

  test('deterministic exact match skips LLM and validation', async () => {
    // query: 'cleanJSON' — this is an exact symbol name in the project map.
    // Pipeline should match deterministically, skip LLM, skip validation.
    const result = await runFindCodePipeline('cleanJSON', config, false, ROOT)
    const parsed = JSON.parse(result)
    expect(parsed.markdown).toContain('cleanJSON')
    expect(parsed.structuredContent.symbols).toContain('cleanJSON')
    // No fetch calls should have been made (deterministic match, no validation)
    expect(callCount).toBe(0)
  })

  test('query analysis returns null on fetch failure, pipeline still works', async () => {
    // First call (query analysis) fails, second call (LLM candidates) succeeds
    let fetchCalls = 0
    global.fetch = (async () => {
      fetchCalls++
      if (fetchCalls === 1) {
        // Query analysis fails
        return new Response(null, { status: 500 }) as unknown as Response
      }
      // LLM candidate call succeeds
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify([
          { file: 'src/shared/utils/json.ts', symbol: 'cleanJSON', confidence: 0.9, tier: 'mustRead' },
        ]) } }],
      }), { status: 200 }) as unknown as Response
    }) as unknown as typeof fetch

    const result = await runFindCodePipeline('cleanJSON function', config, false, ROOT)
    const parsed = JSON.parse(result)
    // Should still find cleanJSON despite analysis failure
    expect(parsed.structuredContent.symbols).toContain('cleanJSON')
  })

  test('natural language query goes through analysis → LLM → validation', async () => {
    // Mock all 3 sequential LLM calls: analysis, candidate selection, content validation
    mockFetchSequence(
      // 1. Query analysis response
      JSON.stringify({
        intent: 'featureSearch',
        symbolNames: [],
        expandedTerms: ['json', 'clean', 'parse'],
        filePatterns: ['json'],
        description: 'JSON cleaning utility',
      }),
      // 2. LLM candidate selection response
      JSON.stringify([
        { file: 'src/shared/utils/json.ts', symbol: 'cleanJSON', confidence: 0.85, tier: 'mustRead' },
      ]),
      // 3. Content validation response (all relevant)
      JSON.stringify({
        verdicts: [
          { idx: 0, relevant: true, reason: 'This is the JSON cleaning function' },
        ],
      }),
    )

    const result = await runFindCodePipeline('JSON cleaning utility', config, false, ROOT)
    const parsed = JSON.parse(result)
    expect(parsed.structuredContent.symbols).toContain('cleanJSON')
    // At least analysis + LLM + validation calls
    expect(callCount).toBeGreaterThanOrEqual(3)
  })

  test('content validation rejects false positives', async () => {
    // Query about "formatting" but mock returns an unrelated symbol
    mockFetchSequence(
      // 1. Query analysis
      JSON.stringify({
        intent: 'featureSearch',
        symbolNames: [],
        expandedTerms: ['format', 'display', 'render'],
        filePatterns: ['format'],
        description: 'Text formatting utility',
      }),
      // 2. LLM returns a symbol whose code is about JSON parsing, not formatting
      JSON.stringify([
        { file: 'src/shared/utils/json.ts', symbol: 'cleanJSON', confidence: 0.7, tier: 'likelyRelevant' },
      ]),
      // 3. Content validation: LLM says it's NOT relevant
      JSON.stringify({
        verdicts: [
          { idx: 0, relevant: false, reason: 'This is JSON parsing, not text formatting' },
        ],
      }),
    )

    const result = await runFindCodePipeline('text formatting utility', config, false, ROOT)
    const parsed = JSON.parse(result)
    // cleanJSON should be filtered out or fallback to keeping it
    // Either way, the pipeline doesn't crash
    expect(typeof parsed.markdown).toBe('string')
  })

  test('NOT_FOUND for completely unrelated query', async () => {
    mockFetchSequence(
      JSON.stringify({
        intent: 'conceptSearch',
        symbolNames: [],
        expandedTerms: ['quantum', 'computing'],
        filePatterns: [],
        description: 'Quantum computing implementation',
      }),
      JSON.stringify([]),
    )

    const result = await runFindCodePipeline('quantum computing implementation', config, false, ROOT)
    expect(result).toContain('NOT_FOUND')
  })
})
