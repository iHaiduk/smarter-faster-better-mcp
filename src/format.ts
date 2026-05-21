// Refactored: 2026-05-21 — modern JS/TS
// Formatting layer: turns Scout state into markdown payloads for the caller LLM.

import type { ExtractedSymbol, SymbolEntry, SymbolKind } from './types.js'

const MAX_DEP_LIST = 8
const MAX_SIG_CHARS = 80
const MAX_DOC_CHARS = 60

const KIND_SHORT = {
  FunctionDeclaration: 'fn',
  ClassDeclaration: 'cls',
  MethodDefinition: 'method',
  TSInterfaceDeclaration: 'iface',
  TSTypeAliasDeclaration: 'type',
  ArrowFunctionExpression: 'fn',
  JSONProperty: 'json',
} as const satisfies Record<SymbolKind, string>

export function kindShort(kind: SymbolKind): string {
  return KIND_SHORT[kind] ?? '?'
}

/** Renders extracted symbols as a markdown payload for the calling LLM. */
export function formatFound(
  extractions: readonly ExtractedSymbol[],
  gitStatusMap?: ReadonlyMap<string, string>,
): string {
  const sections: string[] = ['[Scout: FOUND]']
  for (const ext of extractions) {
    const loc = ext.startLine && ext.endLine ? `:L${ext.startLine}-${ext.endLine}` : ''
    const lines: string[] = [`## ${ext.candidate.symbol} (${ext.candidate.file}${loc})`]

    if (ext.doc) lines.push(`/* ${ext.doc} */`)
    lines.push(`\`\`\`ts\n${ext.code}\n\`\`\``)
    if (!ext.extractionOk) lines.push('// ⚠ Exact extraction failed')

    const meta: string[] = []
    if (ext.imports.length > 0) meta.push(`Deps: ${ext.imports.slice(0, MAX_DEP_LIST).join(', ')}`)
    if (ext.importedBy.length > 0) meta.push(`Used: ${ext.importedBy.join(', ')}`)

    const gitStatus = gitStatusMap?.get(ext.candidate.file)
    if (gitStatus) meta.push(`Git: ${gitStatus}`)
    if (meta.length > 0) lines.push(meta.join(' | '))

    if (ext.typeDefs && ext.typeDefs.length > 0) {
      lines.push('\n**Associated Types:**')
      for (const def of ext.typeDefs) lines.push(`\`\`\`ts\n${def}\n\`\`\``)
    }

    sections.push(lines.join('\n'))
  }
  return sections.join('\n---\n')
}

export function formatNotFound(task: string, symbolsCount: number): string {
  return [
    '[Scout: NOT_FOUND]',
    `No code found for: "${task}"`,
    '',
    'This feature does not exist in the project yet.',
    'Proceed with implementation according to your plan.',
    symbolsCount > 0
      ? `Project has ${symbolsCount} symbols — none matched.`
      : 'Project map is empty — this appears to be a new project.',
  ].join('\n')
}

export function formatDegraded(reason: string): string {
  return [
    '[Scout: DEGRADED]',
    `Scout encountered an issue: ${reason}`,
    '',
    'Proceeding without Scout context is safe — continue with your task.',
    'Check SCOUT_BASE_URL and that your local LLM is running.',
  ].join('\n')
}

/** Token-efficient compact form for LLM consumption (grouped by file). */
export function serializeForLLM(symbols: readonly SymbolEntry[]): string {
  const byFile = new Map<string, SymbolEntry[]>()
  for (const sym of symbols) {
    const bucket = byFile.get(sym.file)
    if (bucket) bucket.push(sym)
    else byFile.set(sym.file, [sym])
  }

  const lines: string[] = []
  for (const [file, syms] of byFile) {
    lines.push(`File: ${file}`)
    for (const sym of syms) {
      const sig = sym.signature.slice(0, MAX_SIG_CHARS)
      const doc = sym.doc ? ` — ${sym.doc.slice(0, MAX_DOC_CHARS)}` : ''
      lines.push(`${kindShort(sym.kind)}: ${sig}${doc}`)
    }
  }
  return lines.join('\n')
}
