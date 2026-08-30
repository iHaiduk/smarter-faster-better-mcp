import { describe, it, expect } from 'bun:test'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'

import { TypeScriptDiagnosticsService } from '../lsp/ts-diagnostics.js'
import { applyIncrementalChanges } from '../indexing/symbol-map/incremental-update.js'
import { WorkspaceWatcher } from '../indexing/watcher/workspace-watcher.js'
import type { ProjectMap } from '../shared/types/index.js'

describe('TypeScriptDiagnosticsService', () => {
  const root = process.cwd()
  const diagService = new TypeScriptDiagnosticsService(root)

  it('reports diagnostics clean for valid codebase files', async () => {
    const diags = await diagService.getDiagnostics({ file: 'src/config/index.ts', severity: 'error' })
    expect(diags).toHaveLength(0)
  })

  it('correctly reports syntax / type errors when checking dynamic content or invalid files', async () => {
    const tempFile = path.join(root, 'src/__tests__/fixtures/dummy-error.ts')
    await fs.mkdir(path.dirname(tempFile), { recursive: true })
    await fs.writeFile(tempFile, 'const x: number = "hello world";\nimport { nonExistent } from "./nonExistent";\n', 'utf8')

    try {
      await diagService.syncFile(tempFile)
      const diags = await diagService.getDiagnostics({ file: tempFile, severity: 'error' })
      expect(diags.length).toBeGreaterThan(0)
      const hasTypeError = diags.some((d) => d.code === 2322 || d.message.includes('Type'))
      expect(hasTypeError).toBe(true)
    } finally {
      diagService.removeFile(tempFile)
      await fs.unlink(tempFile).catch(() => undefined)
    }
  })
})

describe('Incremental ProjectMap Update & Watcher', () => {
  it('applies incremental file changes without rebuilding the full map', async () => {
    const root = process.cwd()
    const initialMap: ProjectMap = {
      generatedAt: Date.now(),
      parserMode: 'oxc',
      symbolsCount: 1,
      symbols: [
        {
          name: 'oldFunc',
          file: 'src/temp-test-file.ts',
          line: 1,
          kind: 'FunctionDeclaration',
          signature: 'function oldFunc(): void',
          doc: '',
        },
      ],
      files: [
        {
          file: 'src/temp-test-file.ts',
          imports: [],
          exports: [{ name: 'oldFunc', local: 'oldFunc' }],
          reExports: [],
          declarations: ['oldFunc'],
        },
      ],
    }

    const updated = await applyIncrementalChanges(
      initialMap,
      [{ path: 'src/temp-test-file.ts', type: 'unlink' }],
      root,
    )

    expect(updated.symbols.find((s) => s.name === 'oldFunc')).toBeUndefined()
    expect(updated.symbolsCount).toBe(0)
  })

  it('initializes and stops WorkspaceWatcher cleanly', async () => {
    const watcher = new WorkspaceWatcher(process.cwd())
    watcher.start()
    await watcher.stop()
    expect(watcher.getMap()).toBeNull()
  })
})
