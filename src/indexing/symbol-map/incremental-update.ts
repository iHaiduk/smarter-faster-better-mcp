import * as path from 'node:path'
import * as fs from 'node:fs/promises'

import { parseFile } from '../parser/oxc-walker.js'
import { loadTsConfigPaths } from '../resolver/tsconfig-paths.js'
import { findDepsStructured } from '../../dependency-resolver/deps.js'
import { l1Cache } from '../../cache/l1.js'
import { getMapFilePath, getParserMode } from '../../config/index.js'
import type { FileMetadata, ParserMode, ProjectMap } from '../../shared/types/index.js'

export interface IncrementalFileChange {
  readonly path: string
  readonly type: 'add' | 'change' | 'unlink'
}

/**
 * Updates ProjectMap in-memory and returns a fresh immutable ProjectMap snapshot (Copy-on-Write).
 * Also invalidates L1 cache for the changed file and its reverse dependents if exports changed.
 */
export async function applyIncrementalChanges(
  currentMap: ProjectMap,
  changes: readonly IncrementalFileChange[],
  targetRoot: string,
  _configuredParserMode: ParserMode = getParserMode(),
): Promise<ProjectMap> {
  if (changes.length === 0) return currentMap

  const effectiveParserMode: 'oxc' | 'tree-sitter' =
    currentMap.parserMode && currentMap.parserMode !== 'auto'
      ? currentMap.parserMode
      : 'oxc'

  const tsconfig = await loadTsConfigPaths(targetRoot)

  const fileMetaMap = new Map<string, FileMetadata>(
    (currentMap.files ?? []).map((f) => [f.file, f]),
  )
  let symbols = [...currentMap.symbols]

  for (const change of changes) {
    const relFile = path.normalize(change.path).replace(/\\/g, '/')

    // 1. Remove old symbols and file metadata for this file
    symbols = symbols.filter((s) => s.file !== relFile)
    const oldMeta = fileMetaMap.get(relFile)
    fileMetaMap.delete(relFile)

    // Clear L1 cache entries for this file
    for (const key of l1Cache.keys()) {
      if (key.includes(relFile)) {
        l1Cache.delete(key)
      }
    }

    // 2. If it's a deletion, invalidate reverse dependents
    if (change.type === 'unlink') {
      if (oldMeta) {
        for (const exp of oldMeta.exports) {
          const deps = findDepsStructured(exp.name, relFile, currentMap)
          for (const depFile of deps.allFiles) {
            for (const key of l1Cache.keys()) {
              if (key.includes(depFile)) l1Cache.delete(key)
            }
          }
        }
      }
      continue
    }

    // 3. For add or change, reparse the file
    try {
      const parseRes = await parseFile(
        relFile,
        targetRoot,
        effectiveParserMode,
        tsconfig.paths,
        tsconfig.baseUrl,
      )

      fileMetaMap.set(relFile, parseRes.metadata)
      symbols.push(...parseRes.symbols)

      // Invalidate cache for dependents if exports changed
      const newExportNames = new Set(parseRes.metadata.exports.map((e) => e.name))
      const oldExportNames = new Set(oldMeta?.exports.map((e) => e.name) ?? [])

      let exportsChanged = newExportNames.size !== oldExportNames.size
      if (!exportsChanged) {
        for (const name of newExportNames) {
          if (!oldExportNames.has(name)) {
            exportsChanged = true
            break
          }
        }
      }

      if (exportsChanged && oldMeta) {
        for (const exp of oldMeta.exports) {
          const deps = findDepsStructured(exp.name, relFile, currentMap)
          for (const depFile of deps.allFiles) {
            for (const key of l1Cache.keys()) {
              if (key.includes(depFile)) l1Cache.delete(key)
            }
          }
        }
      }
    } catch (err) {
      console.error(`[Scout] Incremental parse failed for ${relFile}:`, err)
    }
  }

  const updatedFiles = Array.from(fileMetaMap.values())
  const newMap: ProjectMap = {
    generatedAt: Date.now(),
    parserMode: effectiveParserMode,
    symbolsCount: symbols.length,
    symbols,
    files: updatedFiles,
  }

  // Atomic write to disk (.tmp -> rename)
  try {
    const mapPath = getMapFilePath(targetRoot)
    const tmpPath = `${mapPath}.tmp`
    await fs.writeFile(tmpPath, JSON.stringify(newMap), 'utf8')
    await fs.rename(tmpPath, mapPath)
  } catch (err) {
    console.error('[Scout] Failed to save updated map to disk:', err)
  }

  return newMap
}
