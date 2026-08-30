import { describe, it, expect } from 'bun:test'
import {
  discoverEntrypoints,
  findReachableFiles,
  findDeadExports,
  analyzeDeadCode,
} from '../analysis/dead-code.js'
import type { ProjectMap } from '../shared/types/index.js'

describe('Dead Code Detection Engine', () => {
  it('identifies entrypoints from standard file patterns and options', async () => {
    const map: ProjectMap = {
      generatedAt: Date.now(),
      symbolsCount: 3,
      symbols: [],
      files: [
        { file: 'src/index.ts', imports: [], exports: [], reExports: [], declarations: [] },
        { file: 'src/utils.ts', imports: [], exports: [], reExports: [], declarations: [] },
        { file: 'eslint.config.js', imports: [], exports: [], reExports: [], declarations: [] },
      ],
    }

    const eps = await discoverEntrypoints(process.cwd(), map, ['src/custom-entry.ts'])
    expect(eps).toContain('src/index.ts')
    expect(eps).toContain('eslint.config.js')
    expect(eps).toContain('src/custom-entry.ts')
    expect(eps).not.toContain('src/utils.ts')
  })

  it('detects orphan dead files unreachable from entrypoint and isolated cycles', () => {
    // entrypoint: index.ts -> app.ts
    // dead island: deadA.ts <-> deadB.ts
    // completely isolated: lonely.ts
    const map: ProjectMap = {
      generatedAt: Date.now(),
      symbolsCount: 5,
      symbols: [],
      files: [
        {
          file: 'src/index.ts',
          imports: [{ source: './app', resolved: 'src/app.ts', specifiers: [] }],
          exports: [],
          reExports: [],
          declarations: [],
        },
        {
          file: 'src/app.ts',
          imports: [],
          exports: [],
          reExports: [],
          declarations: [],
        },
        {
          file: 'src/deadA.ts',
          imports: [{ source: './deadB', resolved: 'src/deadB.ts', specifiers: [] }],
          exports: [],
          reExports: [],
          declarations: [],
        },
        {
          file: 'src/deadB.ts',
          imports: [{ source: './deadA', resolved: 'src/deadA.ts', specifiers: [] }],
          exports: [],
          reExports: [],
          declarations: [],
        },
        {
          file: 'src/lonely.ts',
          imports: [],
          exports: [],
          reExports: [],
          declarations: [],
        },
      ],
    }

    const { reachableFiles, deadFiles } = findReachableFiles(['src/index.ts'], map)

    expect(reachableFiles.has('src/index.ts')).toBe(true)
    expect(reachableFiles.has('src/app.ts')).toBe(true)
    expect(reachableFiles.has('src/deadA.ts')).toBe(false)
    expect(reachableFiles.has('src/deadB.ts')).toBe(false)
    expect(reachableFiles.has('src/lonely.ts')).toBe(false)

    expect(deadFiles).toContain('src/deadA.ts')
    expect(deadFiles).toContain('src/deadB.ts')
    expect(deadFiles).toContain('src/lonely.ts')
    expect(deadFiles).not.toContain('src/app.ts')
  })

  it('detects unused exported symbols while preserving used imports and wildcard exports', () => {
    const map: ProjectMap = {
      generatedAt: Date.now(),
      symbolsCount: 4,
      symbols: [
        { name: 'usedFunction', file: 'src/utils.ts', line: 10, kind: 'FunctionDeclaration', signature: '', doc: '' },
        { name: 'unusedFunction', file: 'src/utils.ts', line: 20, kind: 'FunctionDeclaration', signature: '', doc: '' },
      ],
      files: [
        {
          file: 'src/index.ts',
          imports: [
            {
              source: './utils',
              resolved: 'src/utils.ts',
              specifiers: [{ local: 'usedFunction', imported: 'usedFunction' }],
            },
          ],
          exports: [],
          reExports: [],
          declarations: [],
        },
        {
          file: 'src/utils.ts',
          imports: [],
          exports: [
            { name: 'usedFunction', local: 'usedFunction' },
            { name: 'unusedFunction', local: 'unusedFunction' },
          ],
          reExports: [],
          declarations: ['usedFunction', 'unusedFunction'],
        },
      ],
    }

    const reachable = new Set(['src/index.ts', 'src/utils.ts'])
    const deadExports = findDeadExports(reachable, map)

    expect(deadExports.length).toBe(1)
    expect(deadExports[0].name).toBe('unusedFunction')
    expect(deadExports[0].file).toBe('src/utils.ts')
    expect(deadExports[0].line).toBe(20)
  })

  it('runs full dead code analysis cleanly', async () => {
    const map: ProjectMap = {
      generatedAt: Date.now(),
      symbolsCount: 2,
      symbols: [
        { name: 'main', file: 'src/index.ts', line: 1, kind: 'FunctionDeclaration', signature: '', doc: '' },
      ],
      files: [
        { file: 'src/index.ts', imports: [], exports: [], reExports: [], declarations: ['main'] },
      ],
    }

    const report = await analyzeDeadCode(process.cwd(), map)
    expect(report.summary.deadFilesCount).toBe(0)
    expect(report.summary.deadExportsCount).toBe(0)
  })
})
