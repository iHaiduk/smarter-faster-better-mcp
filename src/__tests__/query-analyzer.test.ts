import { describe, expect, test, mock, beforeEach } from 'bun:test'

const mockConfig = {
  baseUrl: 'http://localhost:1234/v1',
  apiKey: 'test-key',
  model: 'test-model',
  llmTimeoutMs: 5000,
  llmParallelism: 2,
  parser: 'oxc' as const,
}

function mockFetchResponse(content: string) {
  const originalFetch = global.fetch
  global.fetch = (async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
  })) as unknown as typeof fetch
  return originalFetch
}

describe('analyzeQuery', () => {
  beforeEach(async () => {
    const { clearQueryCache } = await import('../cache/query-cache.js')
    clearQueryCache()
  })
  test('parses specificSymbol intent from LLM response', async () => {
    const originalFetch = mockFetchResponse(
      JSON.stringify({
        intent: 'specificSymbol',
        symbolNames: ['useChatRoomPresence'],
        expandedTerms: ['chat room', 'presence', 'online status', 'real-time'],
        filePatterns: ['presence', 'chat', 'hook'],
        description: 'A React hook for tracking user presence in chat rooms',
      }),
    )

    try {
      const { analyzeQuery } = await import('../extraction/query-analyzer.js')
      const result = await analyzeQuery('useChatRoomPresence hook for online status', mockConfig)

      expect(result).not.toBeNull()
      expect(result!.intent).toBe('specificSymbol')
      expect(result!.symbolNames).toContain('useChatRoomPresence')
      expect(result!.expandedTerms.length).toBeGreaterThan(0)
      expect(result!.filePatterns).toContain('presence')
      expect(result!.description).toContain('chat rooms')
    } finally {
      global.fetch = originalFetch
    }
  })

  test('parses featureSearch intent', async () => {
    const originalFetch = mockFetchResponse(
      JSON.stringify({
        intent: 'featureSearch',
        symbolNames: [],
        expandedTerms: ['authentication', 'login', 'auth guard', 'session'],
        filePatterns: ['auth', 'login', 'session'],
        description: 'User authentication and login flow',
      }),
    )

    try {
      const { analyzeQuery } = await import('../extraction/query-analyzer.js')
      const result = await analyzeQuery('how does user authentication work', mockConfig)

      expect(result).not.toBeNull()
      expect(result!.intent).toBe('featureSearch')
      expect(result!.symbolNames).toHaveLength(0)
      expect(result!.expandedTerms).toContain('authentication')
    } finally {
      global.fetch = originalFetch
    }
  })

  test('returns null for very short queries', async () => {
    const { analyzeQuery } = await import('../extraction/query-analyzer.js')
    const result = await analyzeQuery('hi', mockConfig)
    expect(result).toBeNull()
  })

  test('returns null for single-word queries that look like symbol names', async () => {
    const { analyzeQuery } = await import('../extraction/query-analyzer.js')
    const result = await analyzeQuery('askCheapLLM', mockConfig)
    expect(result).toBeNull()
  })

  test('uses heuristic symbol detection when LLM returns empty symbolNames', async () => {
    const originalFetch = mockFetchResponse(
      JSON.stringify({
        intent: 'specificSymbol',
        symbolNames: [],
        expandedTerms: ['chat', 'presence'],
        filePatterns: ['chat'],
        description: 'Chat room presence tracking',
      }),
    )

    try {
      const { analyzeQuery } = await import('../extraction/query-analyzer.js')
      const result = await analyzeQuery('useChatRoomPresence hook', mockConfig)

      expect(result).not.toBeNull()
      // Heuristic should detect "useChatRoomPresence" as a code identifier
      expect(result!.symbolNames).toContain('useChatRoomPresence')
    } finally {
      global.fetch = originalFetch
    }
  })

  test('returns null on HTTP error', async () => {
    const originalFetch = global.fetch
    global.fetch = (async () => ({
      ok: false,
      status: 500,
    })) as unknown as typeof fetch

    try {
      const { analyzeQuery } = await import('../extraction/query-analyzer.js')
      const result = await analyzeQuery('useChatRoomPresence hook', mockConfig)
      expect(result).toBeNull()
    } finally {
      global.fetch = originalFetch
    }
  })

  test('returns null on malformed JSON response', async () => {
    const originalFetch = mockFetchResponse('not valid json {{{')

    try {
      const { analyzeQuery } = await import('../extraction/query-analyzer.js')
      const result = await analyzeQuery('useChatRoomPresence hook', mockConfig)
      expect(result).toBeNull()
    } finally {
      global.fetch = originalFetch
    }
  })

  test('defaults intent to conceptSearch for unknown intent', async () => {
    const originalFetch = mockFetchResponse(
      JSON.stringify({
        intent: 'unknownIntent',
        symbolNames: [],
        expandedTerms: [],
        filePatterns: [],
        description: 'test',
      }),
    )

    try {
      const { analyzeQuery } = await import('../extraction/query-analyzer.js')
      const result = await analyzeQuery('something weird and unknown', mockConfig)

      expect(result).not.toBeNull()
      expect(result!.intent).toBe('conceptSearch')
    } finally {
      global.fetch = originalFetch
    }
  })
})

describe('filterMap with QueryAnalysis', () => {
  const sampleMap = {
    generatedAt: 0,
    symbolsCount: 5,
    symbols: [
      { name: 'useChatRoomPresence', file: 'src/hooks/useChatRoomPresence.ts', line: 1, kind: 'FunctionDeclaration' as const, signature: 'function useChatRoomPresence()', doc: 'Track user presence in chat rooms' },
      { name: 'ChatRoom', file: 'src/components/ChatRoom.tsx', line: 1, kind: 'ClassDeclaration' as const, signature: 'class ChatRoom', doc: 'Chat room component' },
      { name: 'UserStatus', file: 'src/types/user.ts', line: 1, kind: 'TSInterfaceDeclaration' as const, signature: 'interface UserStatus', doc: 'User online status type' },
      { name: 'parseFile', file: 'src/parser.ts', line: 1, kind: 'FunctionDeclaration' as const, signature: 'function parseFile()', doc: '' },
      { name: 'totallyUnrelated', file: 'src/misc.ts', line: 1, kind: 'FunctionDeclaration' as const, signature: 'function totallyUnrelated()', doc: '' },
    ],
  }

  test('analysis boosts matching symbols via symbolNames', async () => {
    const { filterMap } = await import('../extraction/matcher/filter.js')
    const analysis = {
      intent: 'specificSymbol' as const,
      symbolNames: ['useChatRoomPresence'],
      expandedTerms: ['presence', 'online'],
      filePatterns: ['presence', 'hook'],
      description: 'Hook for online presence',
    }

    const result = filterMap(sampleMap, 'useChatRoomPresence hook for online status', analysis)
    // useChatRoomPresence should be near the top
    expect(result[0]?.name).toBe('useChatRoomPresence')
  })

  test('analysis boosts symbols matching file patterns', async () => {
    const { filterMap } = await import('../extraction/matcher/filter.js')
    const analysis = {
      intent: 'featureSearch' as const,
      symbolNames: [],
      expandedTerms: [],
      filePatterns: ['chat'],
      description: 'Chat related code',
    }

    const result = filterMap(sampleMap, 'chat room features', analysis)
    const names = result.map((s) => s.name)
    // Symbols in files matching "chat" pattern should be boosted
    expect(names).toContain('useChatRoomPresence')
    expect(names).toContain('ChatRoom')
  })
})

describe('getDeterministicMatches with QueryAnalysis', () => {
  const sampleMap = {
    generatedAt: 0,
    symbolsCount: 3,
    symbols: [
      { name: 'useChatRoomPresence', file: 'src/hooks/useChatRoomPresence.ts', line: 1, kind: 'FunctionDeclaration' as const, signature: 'function useChatRoomPresence()', doc: 'Track user presence' },
      { name: 'ChatRoom', file: 'src/components/ChatRoom.tsx', line: 1, kind: 'ClassDeclaration' as const, signature: 'class ChatRoom', doc: '' },
      { name: 'parseFile', file: 'src/parser.ts', line: 1, kind: 'FunctionDeclaration' as const, signature: 'function parseFile()', doc: '' },
    ],
  }

  test('analysis symbolNames enable direct matching even when task keywords fail', async () => {
    const { getDeterministicMatches } = await import('../extraction/matcher/filter.js')
    const analysis = {
      intent: 'specificSymbol' as const,
      symbolNames: ['useChatRoomPresence'],
      expandedTerms: [],
      filePatterns: [],
      description: 'Chat presence hook',
    }

    const result = getDeterministicMatches(sampleMap, 'useChatRoomPresence hook for online status', false, analysis)
    const names = result.map((c) => c.symbol)
    expect(names).toContain('useChatRoomPresence')
    // The analysis-matched symbol should have high confidence
    const match = result.find((c) => c.symbol === 'useChatRoomPresence')
    expect(match!.confidence).toBeGreaterThanOrEqual(0.95)
  })
})
