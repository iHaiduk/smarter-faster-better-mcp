import { describe, expect, test, afterEach } from 'bun:test'

import type { ExtractedSymbol, QueryAnalysis, ScoutConfig } from '../shared/types/index.js'

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
})

const mockConfig: ScoutConfig = {
  baseUrl: 'http://localhost:1234/v1',
  apiKey: 'test-key',
  model: 'test-model',
  llmTimeoutMs: 5000,
  llmParallelism: 2,
  parser: 'oxc',
}

function makeSymbol(
  file: string,
  name: string,
  code: string,
  signature = `function ${name}()`,
): ExtractedSymbol {
  return {
    candidate: { file, symbol: name, confidence: 0.9 },
    code,
    signature,
    doc: '',
    imports: [],
    importedBy: [],
    extractionOk: true,
    startLine: 1,
    endLine: 10,
    relevanceTier: 'mustRead',
  }
}

function mockFetchLlm(verdicts: Array<{ idx: number; relevant: boolean; reason: string }>) {
  global.fetch = (async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ verdicts }) } }],
      }),
      { status: 200 },
    )) as unknown as typeof fetch
}

describe('validateExtractedSymbols', () => {
  test('keeps symbols whose code contains query keywords', async () => {
    const { validateExtractedSymbols } = await import('../extraction/content-validator.js')

    const symbols = [
      makeSymbol('src/hooks/usePresence.ts', 'usePresence', 'export function usePresence() { return { online: true } }'),
      makeSymbol('src/utils/format.ts', 'formatDate', 'export function formatDate(d: Date) { return d.toISOString() }'),
    ]

    const result = await validateExtractedSymbols(symbols, 'online presence status', null, mockConfig)
    const names = result.map((s) => s.candidate.symbol)
    expect(names).toContain('usePresence')
    // formatDate has no "online" or "presence" or "status" — should be rejected
    expect(names).not.toContain('formatDate')
  })

  test('keeps all symbols when query terms match their code', async () => {
    const { validateExtractedSymbols } = await import('../extraction/content-validator.js')

    mockFetchLlm([
      { idx: 0, relevant: true, reason: 'matches' },
    ])

    const symbols = [
      makeSymbol('src/hooks/useOnline.ts', 'useOnline', 'export function useOnline() { const [online, setOnline] = useState(false) }'),
      makeSymbol('src/types/status.ts', 'Status', 'export type Status = "online" | "offline"'),
    ]

    const result = await validateExtractedSymbols(symbols, 'user online status', null, mockConfig)
    expect(result.length).toBe(2)
  })

  test('uses analysis expanded terms for validation', async () => {
    const { validateExtractedSymbols } = await import('../extraction/content-validator.js')

    const symbols = [
      makeSymbol('src/hooks/usePresence.ts', 'usePresence', 'export function usePresence() { /* tracks who is here */ }'),
      makeSymbol('src/utils/unrelated.ts', 'computeHash', 'export function computeHash(s: string) { return s.hashCode() }'),
    ]

    const analysis: QueryAnalysis = {
      intent: 'specificSymbol',
      symbolNames: ['usePresence'],
      expandedTerms: ['who is here', 'tracking', 'visibility'],
      filePatterns: ['presence'],
      description: 'Track who is present',
    }

    const result = await validateExtractedSymbols(symbols, 'show who is present', analysis, mockConfig)
    const names = result.map((s) => s.candidate.symbol)
    expect(names).toContain('usePresence')
    expect(names).not.toContain('computeHash')
  })

  test('keeps symbol matching analysis symbolNames even with low keyword overlap', async () => {
    const { validateExtractedSymbols } = await import('../extraction/content-validator.js')

    const symbols = [
      makeSymbol('src/hooks/useChatRoomPresence.ts', 'useChatRoomPresence', 'export function useChatRoomPresence() { return null }'),
    ]

    const analysis: QueryAnalysis = {
      intent: 'specificSymbol',
      symbolNames: ['useChatRoomPresence'],
      expandedTerms: [],
      filePatterns: [],
      description: 'Chat room presence hook',
    }

    const result = await validateExtractedSymbols(symbols, 'useChatRoomPresence for online', analysis, mockConfig)
    expect(result.length).toBe(1)
    expect(result[0]!.candidate.symbol).toBe('useChatRoomPresence')
  })

  test('returns all symbols on empty input', async () => {
    const { validateExtractedSymbols } = await import('../extraction/content-validator.js')
    const result = await validateExtractedSymbols([], 'test', null, mockConfig)
    expect(result.length).toBe(0)
  })

  test('falls back to first symbol when all are rejected', async () => {
    const { validateExtractedSymbols } = await import('../extraction/content-validator.js')

    // All symbols have code completely unrelated to the query
    const symbols = [
      makeSymbol('src/a.ts', 'foo', 'export function foo() { return 42 }'),
      makeSymbol('src/b.ts', 'bar', 'export function bar() { return "hello" }'),
    ]

    // Mock LLM to also reject all
    mockFetchLlm([
      { idx: 0, relevant: false, reason: 'unrelated' },
      { idx: 1, relevant: false, reason: 'unrelated' },
    ])

    const result = await validateExtractedSymbols(symbols, 'websocket real-time collaboration', null, mockConfig)
    // Should keep at least one as fallback
    expect(result.length).toBeGreaterThanOrEqual(1)
  })
})

describe('validateExtractedSymbols with LLM batch validation', () => {
  test('filters borderline symbols using LLM verdicts', async () => {
    const { validateExtractedSymbols } = await import('../extraction/content-validator.js')

    // Query: "state management" → terms: ["state", "management"]
    // Symbol with borderline deterministic score: code contains "state" but not "management"
    // Score = 1/2 = 0.5 → exactly at KEEP_THRESHOLD, so this goes to borderline zone
    const borderline = makeSymbol(
      'src/file-state.ts',
      'getFileState',
      'export function getFileState(path: string) { return fs.statSync(path) }',
    )
    // Symbol with zero match (fully rejected deterministically, never reaches LLM)
    const unrelated = makeSymbol(
      'src/format.ts',
      'formatDate',
      'export function formatDate(d: Date) { return d.toISOString() }',
    )

    // LLM says getFileState is NOT relevant (it's about file system state, not app state management)
    mockFetchLlm([
      { idx: 0, relevant: false, reason: 'File system stat, not state management' },
    ])

    const result = await validateExtractedSymbols(
      [borderline, unrelated],
      'state management',
      null,
      mockConfig,
    )

    // getFileState rejected by LLM, formatDate rejected deterministically
    // Fallback should keep at least one
    expect(result.length).toBeGreaterThanOrEqual(1)
  })

  test('gracefully degrades when LLM returns invalid JSON', async () => {
    const { validateExtractedSymbols } = await import('../extraction/content-validator.js')

    const symbols = [
      makeSymbol('src/a.ts', 'maybeRelevant', 'export function maybeRelevant() { return 1 }'),
    ]

    // Mock LLM returning garbage
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'not valid json at all' } }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch

    const result = await validateExtractedSymbols(symbols, 'something related', null, mockConfig)
    // Should keep all symbols on LLM failure
    expect(result.length).toBe(1)
  })

  test('gracefully degrades when LLM HTTP fails', async () => {
    const { validateExtractedSymbols } = await import('../extraction/content-validator.js')

    const symbols = [
      makeSymbol('src/a.ts', 'maybeRelevant', 'export function maybeRelevant() { return 1 }'),
    ]

    global.fetch = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch

    const result = await validateExtractedSymbols(symbols, 'something related', null, mockConfig)
    // Should keep all symbols on HTTP failure
    expect(result.length).toBe(1)
  })
})
