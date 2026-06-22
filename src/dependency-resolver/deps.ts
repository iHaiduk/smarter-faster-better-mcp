import type { ProjectMap } from '../shared/types/index.js'

const MAX_DIRECT_IMPORTERS = 20
const MAX_TRANSITIVE_DEPTH = 3

/**
 * Structured dependency result containing categorized dependency information.
 */
export interface DependencyResult {
  readonly directImporters: readonly string[]
  readonly reExporters: readonly string[]
  readonly barrelChain: readonly string[]
  readonly allFiles: readonly string[]
}

/**
 * Finds files referencing `symbolName` from `sourceFile` by traversing
 * the project's parsed AST import/export graph.
 *
 * Returns structured dependency information:
 * - directImporters: files that directly import the symbol
 * - reExporters: files that re-export the symbol (barrel exports)
 * - barrelChain: chain of barrel files leading to the symbol
 * - allFiles: deduplicated list of all dependent files
 */
export async function findDeps(
  symbolName: string,
  sourceFile: string,
  map?: ProjectMap,
): Promise<string[]> {
  const result = findDepsStructured(symbolName, sourceFile, map)
  return [...result.allFiles]
}

/**
 * Extended version of findDeps that returns structured dependency information.
 * Tracks direct imports, re-exports, and barrel chains separately.
 */
export function findDepsStructured(
  symbolName: string,
  sourceFile: string,
  map?: ProjectMap,
): DependencyResult {
  if (!map || !map.files) {
    return { directImporters: [], reExporters: [], barrelChain: [], allFiles: [] }
  }

  const directImporters = new Set<string>()
  const reExporters = new Set<string>()
  const barrelChain: string[] = []
  const seenImporters = new Set<string>()
  const queue: { file: string; symbol: string; depth: number }[] = [{ file: sourceFile, symbol: symbolName, depth: 0 }]
  const processed = new Set<string>()

  while (queue.length > 0) {
    const current = queue.shift()!
    const key = `${current.file}::${current.symbol}`
    if (processed.has(key)) continue
    processed.add(key)

    // Stop transitive traversal at max depth
    if (current.depth >= MAX_TRANSITIVE_DEPTH) continue

    for (const fMeta of map.files) {
      // 1. Direct Imports
      for (const imp of fMeta.imports) {
        if (imp.resolved === current.file) {
          const spec = imp.specifiers.find(
            (s) => s.imported === current.symbol || s.imported === '*',
          )
          if (spec) {
            if (current.depth === 0) {
              directImporters.add(fMeta.file)
            }
            seenImporters.add(fMeta.file)
            queue.push({ file: fMeta.file, symbol: spec.local, depth: current.depth + 1 })
          }
        }
      }

      // 2. Named or Wildcard Re-exports
      for (const reExp of fMeta.reExports) {
        if (reExp.resolved === current.file) {
          if (reExp.specifiers.length === 0) {
            // Wildcard export * from './module'
            if (current.depth === 0) {
              reExporters.add(fMeta.file)
              barrelChain.push(fMeta.file)
            }
            seenImporters.add(fMeta.file)
            queue.push({ file: fMeta.file, symbol: current.symbol, depth: current.depth + 1 })
          } else {
            const spec = reExp.specifiers.find((s) => s.imported === current.symbol)
            if (spec) {
              if (current.depth === 0) {
                reExporters.add(fMeta.file)
                barrelChain.push(fMeta.file)
              }
              seenImporters.add(fMeta.file)
              queue.push({ file: fMeta.file, symbol: spec.local, depth: current.depth + 1 })
            }
          }
        }
      }
    }
  }

  seenImporters.delete(sourceFile)
  const allFiles: string[] = [...seenImporters].slice(0, MAX_DIRECT_IMPORTERS)

  return {
    directImporters: [...directImporters],
    reExporters: [...reExporters],
    barrelChain,
    allFiles,
  }
}
