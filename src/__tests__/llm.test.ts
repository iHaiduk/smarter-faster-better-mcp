// Refactored: 2026-05-21 — modern JS/TS
import { describe, expect, test } from 'bun:test'

import { cleanJSON } from '../llm.js'

describe('cleanJSON', () => {
  test('strips ```json fences', () => {
    expect(cleanJSON('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  test('strips plain ``` fences', () => {
    expect(cleanJSON('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  test('falls back to first `{` / last `}` slice', () => {
    expect(cleanJSON('prelude {"a":1, "b":[1,2]} trailing junk')).toBe('{"a":1, "b":[1,2]}')
  })

  test('handles array objects with first `[` / last `]` slice', () => {
    expect(cleanJSON('prelude [{"a":1}] trailing junk')).toBe('[{"a":1}]')
  })

  test('strips thinking/reasoning blocks before JSON arrays', () => {
    expect(cleanJSON('<think>\nShould use arrays.\n</think>\n  [{"symbol": "X"}]')).toBe('[{"symbol": "X"}]')
  })

  test('returns trimmed raw string when no JSON markers present', () => {
    expect(cleanJSON('  hello  ')).toBe('hello')
  })
})

describe('askCheapLLM tier parsing', () => {
  test('correctly parses and preserves candidates with relevance tiers', async () => {
    const originalFetch = global.fetch
    
    // Mock fetch response
    global.fetch = (async () => {
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  candidates: [
                    { file: 'src/config.ts', symbol: 'SYSTEM_PROMPT', confidence: 0.95, tier: 'mustRead' },
                    { file: 'src/llm.ts', symbol: 'askCheapLLM', confidence: 0.8, tier: 'dependencyOnly' }
                  ]
                })
              }
            }
          ]
        })
      } as unknown as Response
    }) as unknown as typeof fetch

    try {
      const { askCheapLLM } = await import('../llm.js')
      const result = await askCheapLLM(
        'search',
        ['File: a.ts\nfn: x'],
        '',
        {
          baseUrl: 'http://localhost:1234/v1',
          apiKey: 'lm-studio',
          model: 'openai/gpt-oss-20b',
          llmTimeoutMs: 1000,
          confidenceThreshold: 0.5,
          llmParallelism: 1,
          parser: 'oxc'
        }
      )

      expect(result).not.toBeNull()
      expect(result!.length).toBe(2)
      
      const systemPromptCand = result!.find(c => c.symbol === 'SYSTEM_PROMPT')
      expect(systemPromptCand).toBeDefined()
      expect(systemPromptCand!.tier).toBe('mustRead')
      
      const askCheapCand = result!.find(c => c.symbol === 'askCheapLLM')
      expect(askCheapCand).toBeDefined()
      expect(askCheapCand!.tier).toBe('dependencyOnly')
    } finally {
      global.fetch = originalFetch
    }
  })
})
