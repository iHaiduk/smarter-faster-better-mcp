import * as path from 'node:path'

import type { ProjectMap } from './types.js'

const MAX_DEP_FILES = 5

/**
 * Finds up to 5 files referencing `symbolName` from `sourceFile` by traversing
 * the project's parsed AST import/export graph.
 */
export async function findDeps(
  symbolName: string,
  sourceFile: string,
  map?: ProjectMap,
): Promise<string[]> {
  if (!map || !map.files) {
    return []
  }

  const seenImporters = new Set<string>()
  const queue: { file: string; symbol: string }[] = [{ file: sourceFile, symbol: symbolName }]
  const processed = new Set<string>()

  while (queue.length > 0 && seenImporters.size < MAX_DEP_FILES) {
    const current = queue.shift()!
    const key = `${current.file}::${current.symbol}`
    if (processed.has(key)) continue
    processed.add(key)

    for (const fMeta of map.files) {
      if (seenImporters.size >= MAX_DEP_FILES) break

      // 1. Direct Imports
      for (const imp of fMeta.imports) {
        if (imp.resolved === current.file) {
          // Check if it imports our symbol
          const spec = imp.specifiers.find(
            (s) => s.imported === current.symbol || s.imported === '*',
          )
          if (spec) {
            seenImporters.add(fMeta.file)
            // Recursively trace if they import it under a local name
            queue.push({ file: fMeta.file, symbol: spec.local })
          }
        }
      }

      // 2. Named or Wildcard Re-exports
      for (const reExp of fMeta.reExports) {
        if (reExp.resolved === current.file) {
          if (reExp.specifiers.length === 0) {
            // Wildcard export * from './module'
            // This re-exports current.symbol under the same name
            queue.push({ file: fMeta.file, symbol: current.symbol })
          } else {
            // Named re-export e.g. export { x as y } from './module'
            const spec = reExp.specifiers.find((s) => s.imported === current.symbol)
            if (spec) {
              queue.push({ file: fMeta.file, symbol: spec.local })
            }
          }
        }
      }
    }
  }

  seenImporters.delete(sourceFile)
  return [...seenImporters].slice(0, MAX_DEP_FILES)
}
