import { readMap } from '../cache/map-cache.js'
import { findDepsStructured } from '../dependency-resolver/deps.js'
import { toStructuredJSON } from '../bundle/formatter/format.js'
import { getGitStatusMap } from '../shared/utils/git.js'

import type { ExtractedSymbol } from '../shared/types/index.js'

const MAX_BLAST_RADIUS_DEPTH = 3
const MAX_BLAST_RADIUS_FILES = 50

/** Entry in the blast radius result. */
export interface BlastRadiusEntry {
  readonly file: string
  readonly symbol: string
  readonly depth: number
  readonly relationship: 'direct-import' | 're-export' | 'transitive' | 'barrel'
}

/**
 * Computes the blast radius of changing a symbol.
 * Returns all files and symbols that would be affected by modifying the target.
 *
 * @param symbolName - The symbol being changed
 * @param sourceFile - File where the symbol is defined
 * @param targetRoot - Project root directory
 * @returns Structured blast radius report
 */
export async function runBlastRadiusPipeline(
  symbolName: string,
  sourceFile: string,
  targetRoot = process.cwd(),
): Promise<string> {
  const map = await readMap(targetRoot)

  // Find the symbol in the map
  const symbolEntry = map.symbols.find(
    (s) => s.name === symbolName && s.file === sourceFile,
  )

  if (!symbolEntry) {
    return toStructuredJSON(
      `[Scout: BLAST_RADIUS] Symbol "${symbolName}" not found in ${sourceFile}`,
      [],
      0,
      'Symbol not found in project map.',
      [],
      [],
      map,
    )
  }

  // Get structured dependencies
  const deps = findDepsStructured(symbolName, sourceFile, map)

  // Build blast radius entries
  const entries: BlastRadiusEntry[] = []

  // Direct importers (depth 1)
  for (const file of deps.directImporters) {
    entries.push({
      file,
      symbol: symbolName,
      depth: 1,
      relationship: 'direct-import',
    })
  }

  // Re-exporters (depth 1)
  for (const file of deps.reExporters) {
    entries.push({
      file,
      symbol: symbolName,
      depth: 1,
      relationship: 're-export',
    })
  }

  // Barrel chain (depth 1)
  for (const file of deps.barrelChain) {
    if (!entries.some((e) => e.file === file)) {
      entries.push({
        file,
        symbol: symbolName,
        depth: 1,
        relationship: 'barrel',
      })
    }
  }

  // Transitive dependencies (depth 2+)
  const processedFiles = new Set([sourceFile, ...deps.allFiles])
  const transitiveQueue: { file: string; depth: number }[] = []

  // Add direct importers to transitive queue
  for (const file of deps.directImporters) {
    transitiveQueue.push({ file, depth: 2 })
  }

  while (transitiveQueue.length > 0 && entries.length < MAX_BLAST_RADIUS_FILES) {
    const current = transitiveQueue.shift()!
    if (current.depth > MAX_BLAST_RADIUS_DEPTH) continue
    if (processedFiles.has(current.file)) continue
    processedFiles.add(current.file)

    // Find who imports this file
    if (map.files) {
      for (const fMeta of map.files) {
        if (processedFiles.has(fMeta.file)) continue

        for (const imp of fMeta.imports) {
          if (imp.resolved === current.file) {
            if (!entries.some((e) => e.file === fMeta.file)) {
              entries.push({
                file: fMeta.file,
                symbol: symbolName,
                depth: current.depth,
                relationship: 'transitive',
              })
            }
            transitiveQueue.push({ file: fMeta.file, depth: current.depth + 1 })
          }
        }
      }
    }
  }

  // Sort by depth
  entries.sort((a, b) => a.depth - b.depth)

  // Format output
  const affectedFiles = [...new Set(entries.map((e) => e.file))]
  const gitStatusMap = await getGitStatusMap(targetRoot)

  const sections: string[] = [
    `[Scout: BLAST_RADIUS]`,
    `## Blast Radius for ${symbolName} (${sourceFile})`,
    '',
    `**Direct dependents:** ${deps.directImporters.length}`,
    `**Re-exporters:** ${deps.reExporters.length}`,
    `**Total affected files:** ${affectedFiles.length}`,
    '',
  ]

  // Group by depth
  const byDepth = new Map<number, BlastRadiusEntry[]>()
  for (const entry of entries) {
    const group = byDepth.get(entry.depth) ?? []
    group.push(entry)
    byDepth.set(entry.depth, group)
  }

  for (const [depth, group] of byDepth) {
    sections.push(`### Depth ${depth} (${group.length} files)`)
    for (const entry of group) {
      const gitStatus = gitStatusMap.get(entry.file)
      const statusStr = gitStatus ? ` [${gitStatus}]` : ''
      sections.push(`- \`${entry.file}\` (${entry.relationship})${statusStr}`)
    }
    sections.push('')
  }

  // Add risk assessment
  const riskLevel = entries.length > 20 ? 'HIGH' : entries.length > 5 ? 'MEDIUM' : 'LOW'
  sections.push(`### Risk Assessment`)
  sections.push(`**Risk Level:** ${riskLevel}`)
  sections.push(`**Reason:** ${entries.length} files affected across ${byDepth.size} dependency depth levels`)

  // Create extracted symbols for structured output
  const extractedSymbols: ExtractedSymbol[] = entries.slice(0, 10).map((entry) => ({
    candidate: {
      file: entry.file,
      symbol: entry.symbol,
      confidence: 1.0,
    },
    code: `[Blast radius: ${entry.relationship} at depth ${entry.depth}]`,
    signature: `${entry.relationship}: ${entry.file}`,
    doc: `Affected by changes to ${symbolName}`,
    imports: [],
    importedBy: [],
    extractionOk: true,
    relevanceTier: 'mustRead' as const,
  }))

  return toStructuredJSON(
    sections.join('\n'),
    extractedSymbols,
    1.0,
    `Blast radius analysis for ${symbolName}: ${affectedFiles.length} files affected`,
    entries.length > 20
      ? ['High blast radius — consider breaking this change into smaller steps.']
      : [],
    deps.allFiles.map((f) => `trace_symbol: ${symbolName} in ${f}`),
    map,
  )
}
