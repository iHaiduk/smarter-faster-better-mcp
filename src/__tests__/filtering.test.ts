import { describe, expect, test, afterEach } from 'bun:test'
import { interceptFileRead, formatInterceptedMarkdown } from '../shared/filtering/interceptor.js'

const originalFetch = global.fetch

function mockFetchLlm(responseContent: string) {
  global.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: responseContent } }],
  }), { status: 200 }) as unknown as Response
}

function mockFetchFail(status: number) {
  global.fetch = async () => new Response(null, { status }) as unknown as Response
}

describe('File Content Interception & Filtering System', () => {
  afterEach(() => {
    global.fetch = originalFetch
  })

  test('interceptFileRead returns LLM-filtered result when LLM responds', async () => {
    mockFetchLlm(JSON.stringify({
      relevanceScore: 0.95,
      contextualExplanation: 'Highly relevant config file',
      relevantContent: '"key": "value"',
    }))

    const result = await interceptFileRead('config.json', '{"key": "value"}', 'Find config')
    expect(result.relevanceScore).toBe(0.95)
    expect(result.contextualExplanation).toBe('Highly relevant config file')
  })

  test('interceptFileRead falls back when LLM returns HTTP error', async () => {
    mockFetchFail(400)

    const rawContent = 'const a = 12;\nconsole.log(a);'
    const result = await interceptFileRead('test.ts', rawContent, 'Check variable initialization')

    expect(result.relevanceScore).toBe(1.0)
    expect(result.relevantContent).toBe(rawContent)
  })

  test('interceptFileRead falls back when LLM is unreachable', async () => {
    // Mock fetch to throw a network error (simulating unreachable LLM)
    global.fetch = async () => { throw new Error('ECONNREFUSED') }

    const rawContent = 'const a = 12;\nconsole.log(a);'
    const result = await interceptFileRead('test.ts', rawContent, 'Check variable initialization')

    expect(result.relevanceScore).toBe(1.0)
    expect(result.relevantContent).toBe(rawContent)
  })

  test('formatInterceptedMarkdown generates a premium, developer-friendly layout', () => {
    const filtered = {
      relevanceScore: 0.95,
      contextualExplanation: 'This configures swift target flags and prevents warnings on local modules builds.',
      relevantContent: '"SWIFT_COMPILER_FLAGS": "-no-warnings"',
    }

    const markdown = formatInterceptedMarkdown('test-file.json', 10, 20, filtered)

    expect(markdown).toContain('test-file.json')
    expect(markdown).toContain('L10-20')
    expect(markdown).toContain('HIGH RELEVANCE')
    expect(markdown).toContain('95%')
    expect(markdown).toContain(filtered.contextualExplanation)
    expect(markdown).toContain(filtered.relevantContent)
  })
})
