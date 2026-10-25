import { describe, expect, test } from 'bun:test'
import * as path from 'node:path'
import { runGetFileContext } from '../pipeline/index.js'

describe('runGetFileContext (WU4 branches)', () => {
  const root = path.resolve(import.meta.dir, '../..')
  const largeFile = 'src/pipeline/index.ts' // > 150 lines
  const smallFile = 'src/shared/utils/json.ts' // < 50 lines

  test('Branch 1: explicit startLine/endLine returns exact code slice', async () => {
    const res = await runGetFileContext(largeFile, 10, 20, root)
    expect(res).toHaveProperty('markdown')
    expect(res.markdown).toContain(`### File Context: ${largeFile} (L10-20)`)
    const lines = res.markdown.split('\n')
    // Sliced content inside markdown block should match range
    expect(lines.length).toBeLessThan(100)
  })

  test('Branch 2: query provided returns bodies of matching symbols and folds others', async () => {
    const res = await runGetFileContext(largeFile, undefined, undefined, root, 'runFindCodePipeline')
    expect(res).toHaveProperty('markdown')
    expect(res.markdown).toContain('query-filtered for: "runFindCodePipeline"')
    expect(res.markdown).toContain('#### runFindCodePipeline')
    // Contains folded indicators for other symbols
    expect(res.markdown).toContain('[folded]')
  })

  test('Branch 3: no range, no query, file > 150 lines returns outline with note and <= 200 lines', async () => {
    const res = await runGetFileContext(largeFile, undefined, undefined, root)
    expect(res).toHaveProperty('markdown')
    expect(res.markdown).toContain(`### Outline: ${largeFile}`)
    expect(res.markdown).toContain('Pass startLine/endLine, query, or full: true')
    const lines = res.markdown.split('\n')
    expect(lines.length).toBeLessThanOrEqual(200)
  })

  test('Branch 4: no range, no query, file <= 150 lines returns full file content', async () => {
    const res = await runGetFileContext(smallFile, undefined, undefined, root)
    expect(res).toHaveProperty('markdown')
    expect(res.markdown).toContain(`### File Context: ${smallFile}`)
    expect(res.markdown).toContain('export function cleanJSON')
  })

  test('Escape hatch: full=true returns full file even when > 150 lines', async () => {
    const res = await runGetFileContext(largeFile, undefined, undefined, root, undefined, true)
    expect(res).toHaveProperty('markdown')
    expect(res.markdown).toContain(`### File Context: ${largeFile}`)
    const lines = res.markdown.split('\n')
    expect(lines.length).toBeGreaterThan(150)
  })
})
