import { describe, expect, it } from 'bun:test'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { runContextGate, findWorkspaceRoot } from '../bin/context.js'

const execFileAsync = promisify(execFile)

describe('Context CLI Gate (WU6 / Section 8)', () => {
  const root = process.cwd()
  const cliPath = path.join(root, 'dist/bin/context.js')

  describe('In-process runContextGate', () => {
    it('returns exitCode 0 and outline markdown for large source file', async () => {
      const res = await runContextGate('src/pipeline/index.ts')
      expect(res.exitCode).toBe(0)
      expect(res.output).toBeDefined()
      expect(res.output).toContain('### Outline: src/pipeline/index.ts')
      expect(res.output).toContain('Imports:')
      expect(res.output).toContain('// [folded')
      expect(res.output).toContain('src/pipeline/index.ts:L')
    })

    it('returns exitCode 3 (pass-through) for small 10-line source file', async () => {
      const res = await runContextGate('src/shared/constants/tier-scores.ts')
      expect(res.exitCode).toBe(3)
      expect(res.output).toBeUndefined()
    })

    it('returns exitCode 1 for non-code file', async () => {
      const res = await runContextGate('README.md')
      expect(res.exitCode).toBe(1)
    })

    it('returns exitCode 1 for missing file', async () => {
      const res = await runContextGate('non-existent-file-xyz.ts')
      expect(res.exitCode).toBe(1)
    })

    it('returns exitCode 1 for empty or missing argument', async () => {
      const res = await runContextGate('')
      expect(res.exitCode).toBe(1)
    })

    it('findWorkspaceRoot correctly discovers repository root', () => {
      const detected = findWorkspaceRoot(path.join(root, 'src/pipeline/index.ts'))
      expect(detected).toBe(root)
    })
  })

  describe('CLI Process Execution (dist/bin/context.js)', () => {
    it('exits 0 and outputs markdown for large file', async () => {
      const { stdout } = await execFileAsync('bun', [cliPath, 'src/pipeline/index.ts'], { cwd: root })
      expect(stdout).toContain('### Outline: src/pipeline/index.ts')
      expect(stdout).toContain('// [folded')
    })

    it('exits 3 for 10-line file', async () => {
      try {
        await execFileAsync('bun', [cliPath, 'src/shared/constants/tier-scores.ts'], { cwd: root })
        expect(false).toBe(true) // Should not reach here
      } catch (err: unknown) {
        const error = err as { code?: number; status?: number }
        expect(error.code ?? error.status).toBe(3)
      }
    })

    it('exits 1 for non-code file', async () => {
      try {
        await execFileAsync('bun', [cliPath, 'README.md'], { cwd: root })
        expect(false).toBe(true)
      } catch (err: unknown) {
        const error = err as { code?: number; status?: number }
        expect(error.code ?? error.status).toBe(1)
      }
    })

    it('exits 1 for missing file', async () => {
      try {
        await execFileAsync('bun', [cliPath, 'missing-file.ts'], { cwd: root })
        expect(false).toBe(true)
      } catch (err: unknown) {
        const error = err as { code?: number; status?: number }
        expect(error.code ?? error.status).toBe(1)
      }
    })
  })
})
