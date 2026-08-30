import { readMap } from '../cache/map-cache.js'
import { analyzeDeadCode, type DeadCodeOptions } from '../analysis/dead-code.js'
import { toStructuredJSON } from '../bundle/formatter/format.js'
import type { ExtractedSymbol } from '../shared/types/index.js'

/**
 * Runs dead code analysis and formats readable markdown + structured payload.
 */
export async function runDeadCodePipeline(
  targetRoot = process.cwd(),
  options: DeadCodeOptions = {},
): Promise<string> {
  const map = await readMap(targetRoot)
  const report = await analyzeDeadCode(targetRoot, map, options)

  const sections: string[] = [
    `[Scout: DEAD_CODE]`,
    `## Dead Code Analysis Report`,
    '',
    `**Files scanned:** ${report.summary.totalFilesScanned}`,
    `**Entrypoints recognized:** ${report.summary.entrypointsCount}`,
    `**Unreachable/Dead Files:** ${report.summary.deadFilesCount}`,
    `**Unused Named Exports:** ${report.summary.deadExportsCount}`,
    '',
  ]

  if (report.deadFiles.length > 0) {
    sections.push(`### 🗑️ Unreachable / Dead Files (${report.deadFiles.length})`)
    for (const df of report.deadFiles) {
      sections.push(`- \`${df.file}\` — *${df.reason}*`)
    }
    sections.push('')
  }

  if (report.deadExports.length > 0) {
    sections.push(`### ⚠️ Unused Named Exports (${report.deadExports.length})`)
    for (const de of report.deadExports) {
      const loc = de.line ? `:L${de.line}` : ''
      const kindStr = de.kind ? ` [${de.kind}]` : ''
      sections.push(`- \`${de.file}${loc}\` \`${de.name}\`${kindStr} — *${de.reason}*`)
    }
    sections.push('')
  }

  if (report.deadFiles.length === 0 && report.deadExports.length === 0) {
    sections.push('✅ **No dead code detected.** All files and exports are actively referenced or serve as entrypoints.')
    sections.push('')
  }

  // Create extracted symbol items for machine consumption
  const results: ExtractedSymbol[] = [
    ...report.deadFiles.map((df) => ({
      candidate: { file: df.file, symbol: df.name, confidence: df.confidence },
      code: `// Dead file: ${df.file}`,
      signature: `dead_file: ${df.file}`,
      doc: df.reason,
      imports: [],
      importedBy: [],
      extractionOk: true,
      relevanceTier: 'mustRead' as const,
    })),
    ...report.deadExports.map((de) => ({
      candidate: { file: de.file, symbol: de.name, confidence: de.confidence },
      code: `// Unused export: ${de.name} in ${de.file}`,
      signature: `dead_export: ${de.name}`,
      doc: de.reason,
      imports: [],
      importedBy: [],
      extractionOk: true,
      relevanceTier: 'mustRead' as const,
    })),
  ]

  const statusMsg = `Dead code scan complete: ${report.summary.deadFilesCount} dead files, ${report.summary.deadExportsCount} unused exports.`

  return toStructuredJSON(
    sections.join('\n'),
    results,
    1.0,
    statusMsg,
    report.deadFiles.length > 0 ? ['Verify entrypoints and tests before deleting flagged files.'] : [],
    [],
    map,
  )
}
