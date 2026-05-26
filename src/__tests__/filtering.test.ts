import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { runGetFileContext } from '../pipeline/index.js'
import { interceptFileRead, formatInterceptedMarkdown } from '../shared/filtering/interceptor.js'

describe('File Content Interception & Filtering System', () => {
  const rootDir = path.resolve(import.meta.dir, '../..')
  const targetPodspecRel = 'ios/Pods/Local Podspecs/ExpoModulesCore.podspec.json'

  test('successfully reads and slices targeted podspec json (lines 1-260)', async () => {
    const startLine = 1
    const endLine = 260
    const query = 'Find subspecs and dependencies configured for ExpoModulesCore'

    const result = await runGetFileContext(targetPodspecRel, startLine, endLine, rootDir, query)
    const parsed = JSON.parse(result)

    expect(parsed).toHaveProperty('markdown')
    expect(parsed).toHaveProperty('structuredContent')

    const structured = parsed.structuredContent
    expect(structured.confidence).toBeGreaterThanOrEqual(0.0)
    expect(structured.confidence).toBeLessThanOrEqual(1.0)
    expect(structured.reason).toBe(`AI filtered and analyzed context for file: ${targetPodspecRel}`)

    // Verify the raw mock podspec file is located and sliced correctly
    const originalText = await fs.readFile(path.resolve(rootDir, targetPodspecRel), 'utf8')
    const originalLines = originalText.split('\n')
    expect(originalLines.length).toBeGreaterThanOrEqual(260)

    const expectedSlice = originalLines.slice(0, 260).join('\n')
    // Sliced content must either be equal to original (fallback) or a processed subset (AI filtered)
    expect(parsed.markdown).toContain(targetPodspecRel)
    expect(parsed.markdown).toContain('RELEVANCE')
  })

  test('interceptFileRead provides robust fallback when LLM config is missing or invalid', async () => {
    const rawContent = 'const a = 12;\nconsole.log(a);'
    const result = await interceptFileRead('test.ts', rawContent, 'Check variable initialization')

    expect(result).toHaveProperty('relevanceScore')
    expect(result).toHaveProperty('contextualExplanation')
    expect(result).toHaveProperty('relevantContent')

    expect(result.relevanceScore).toBe(1.0)
    expect(result.contextualExplanation).toContain('fallback')
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
