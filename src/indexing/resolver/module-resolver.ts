import * as path from 'node:path'
import * as fs from 'node:fs/promises'

import { fileExists } from '../../utils/nodeUtils.js'

/**
 * Resolves a module specifier (relative or tsconfig-aliased) to a file path
 * relative to `targetRoot`. Returns null when the file cannot be located on disk.
 */
export async function resolveModulePath(
  source: string,
  importingFileRel: string,
  targetRoot: string,
  paths: Record<string, string[]> | undefined,
  baseUrl: string | undefined,
): Promise<string | null> {
  const dir = path.dirname(importingFileRel)
  let resolved: string | null = null

  // 1. Resolve alias
  if (paths) {
    for (const [pattern, targets] of Object.entries(paths)) {
      const regexPattern = pattern.replace(/\*/g, '(.*)')
      const match = new RegExp(`^${regexPattern}$`).exec(source)
      if (match) {
        const subpath = match[1] ?? ''
        for (const target of targets) {
          const mappedTarget = target.replace(/\*/g, subpath)
          const baseDir = baseUrl ? path.join(targetRoot, baseUrl) : targetRoot
          const targetAbs = path.resolve(baseDir, mappedTarget)
          const rel = path.relative(targetRoot, targetAbs)
          resolved = rel
          break
        }
      }
      if (resolved) break
    }
  }

  // 2. Resolve relative
  if (!resolved && source.startsWith('.')) {
    resolved = path.join(dir, source)
  }

  if (!resolved) {
    return null
  }

  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.json', '.d.ts']

  let baseResolved = resolved
  if (resolved.endsWith('.js')) {
    baseResolved = resolved.slice(0, -3)
  } else if (resolved.endsWith('.jsx')) {
    baseResolved = resolved.slice(0, -4)
  } else if (resolved.endsWith('.ts')) {
    baseResolved = resolved.slice(0, -3)
  } else if (resolved.endsWith('.tsx')) {
    baseResolved = resolved.slice(0, -4)
  }

  // Try direct file extensions
  for (const r of [resolved, baseResolved]) {
    for (const ext of ['', ...extensions]) {
      const candidate = ext ? `${r}${ext}` : r
      const absCandidate = path.join(targetRoot, candidate)
      if (await fileExists(absCandidate)) {
        try {
          const stat = await fs.stat(absCandidate)
          if (stat.isDirectory()) continue
        } catch {
          // stat failure after access success is transient; treat as a non-directory file
        }
        return candidate
      }
    }
  }

  // Try index files (barrel exports)
  for (const ext of extensions) {
    const indexCandidate = path.join(resolved, `index${ext}`)
    const absCandidate = path.join(targetRoot, indexCandidate)
    if (await fileExists(absCandidate)) {
      return indexCandidate
    }
  }

  return null
}
