import type {
  ExtractedSymbol,
  StructuredOutput,
  SymbolEntry,
  SymbolKind,
  ProjectMap,
} from '../../shared/types/index.js'

const MAX_SIG_CHARS = 80
const MAX_DOC_CHARS = 60
const MAX_USED_LIST = 3
const MAX_STRUCTURED_DEPENDENCIES = 12
const MAX_FOLLOW_UP_QUERIES = 6

const KIND_SHORT = {
  FunctionDeclaration: 'fn',
  ClassDeclaration: 'cls',
  MethodDefinition: 'method',
  TSInterfaceDeclaration: 'iface',
  TSTypeAliasDeclaration: 'type',
  ArrowFunctionExpression: 'fn',
  JSONProperty: 'json',
  StructDeclaration: 'struct',
  InterfaceDeclaration: 'iface',
  TypeDeclaration: 'type',
} as const satisfies Record<SymbolKind, string>

export function kindShort(kind: SymbolKind): string {
  return KIND_SHORT[kind] ?? '?'
}

/** Renders extracted symbols as a markdown payload for the calling LLM. */
export function formatFound(
  extractions: readonly ExtractedSymbol[],
  _gitStatusMap?: ReadonlyMap<string, string>,
): string {
  const sections: string[] = ['[Scout: FOUND]']
  for (const ext of extractions) {
    const loc = ext.startLine && ext.endLine ? `:L${ext.startLine}-${ext.endLine}` : ''
    const tierLabel =
      ext.relevanceTier && ext.relevanceTier !== 'mustRead'
        ? ` [Tier: ${ext.relevanceTier}]`
        : ''
    const lines: string[] = [`## ${ext.candidate.symbol} (${ext.candidate.file}${loc})${tierLabel}`]

    if (ext.doc) lines.push(`/* ${ext.doc} */`)

    const showFullCode = !ext.relevanceTier || ext.relevanceTier === 'mustRead'
    const codeBlockContent = showFullCode ? ext.code : ext.signature
    lines.push(`\`\`\`ts\n${codeBlockContent}\n\`\`\``)

    if (!ext.extractionOk) {
      lines.push('// ⚠ AST fallback')
    }

    const meta: string[] = []
    if (ext.importedBy.length > 0) {
      meta.push(`Used: ${ext.importedBy.slice(0, MAX_USED_LIST).join(', ')}`)
    }

    if (meta.length > 0) lines.push(meta.join(' | '))

    sections.push(lines.join('\n'))
  }
  return sections.join('\n---\n')
}

export function formatNotFound(task: string, symbolsCount: number): string {
  return [
    '[Scout: NOT_FOUND]',
    `No indexed symbols matched: "${task}"`,
    '',
    'The symbol was not found in the current project map.',
    'The index may be stale or may not include recently added/modified files.',
    'Recommendation: verify with filesystem search (grep/rg) before creating new code to avoid duplication.',
    symbolsCount > 0
      ? `Project has ${symbolsCount} indexed symbols — none matched.`
      : 'Project map is empty — consider running refresh_map.',
  ].join('\n')
}

export function formatDegraded(reason: string): string {
  return [
    '[Scout: DEGRADED]',
    `Scout encountered an issue: ${reason}`,
    '',
    'Retry find_code once with the same task before falling back to filesystem search.',
    'Only use grep/glob/list_dir/read_file after two failed or degraded Scout attempts.',
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

/** Builds the pipe-delimited symbols table row for structured output. */
function buildSymbolsTable(extractions: readonly ExtractedSymbol[]): string {
  const rows = extractions.map((ext) => {
    const lines = ext.startLine && ext.endLine ? `${ext.startLine}-${ext.endLine}` : ''
    const status = ext.extractionOk ? 'ok' : 'fallback'
    const tier = ext.relevanceTier ?? ''
    return `${ext.candidate.file}|${ext.candidate.symbol}|${lines}|${tier}|${status}`
  })
  return ['file|symbol|lines|tier|status', ...rows].join('\n')
}

/**
 * Resolves exact symbol lines for deps actually referenced in extracted code,
 * falling back to the raw import/importedBy lists when no symbol lines are found.
 */
function buildDepsString(extractions: readonly ExtractedSymbol[], map: ProjectMap | undefined): string {
  if (map?.files) {
    const depsWithLines = new Map<string, Set<number>>()
    for (const ext of extractions) {
      const fileMeta = map.files.find((f) => f.file === ext.candidate.file)
      if (!fileMeta) continue
      for (const imp of fileMeta.imports) {
        if (!imp.resolved) continue
        if (!imp.resolved.startsWith('.') && !imp.resolved.includes('/')) continue
        for (const spec of imp.specifiers) {
          const regex = new RegExp(`\\b${spec.local}\\b`)
          if (regex.test(ext.code)) {
            const sym = map.symbols.find((s) => s.file === imp.resolved && s.name === spec.imported)
            if (sym) {
              const existing = depsWithLines.get(imp.resolved) ?? new Set<number>()
              existing.add(sym.line)
              depsWithLines.set(imp.resolved, existing)
            }
          }
        }
      }
    }
    if (depsWithLines.size > 0) {
      return [...depsWithLines.entries()]
        .map(([file, lines]) => `${file}[${[...lines].toSorted((a, b) => a - b).join(',')}]`)
        .slice(0, MAX_STRUCTURED_DEPENDENCIES)
        .join(',')
    }
  }

  return [
    ...new Set(
      extractions
        .flatMap((ext) => [...ext.imports, ...ext.importedBy])
        .filter((dep) => dep.startsWith('.') || dep.includes('/')),
    ),
  ]
    .slice(0, MAX_STRUCTURED_DEPENDENCIES)
    .join(',')
}

/** Wraps a Markdown output and structured extractions into a unified JSON string payload. */
export function toStructuredJSON(
  markdown: string,
  extractions: readonly ExtractedSymbol[],
  confidence: number,
  reason: string,
  missingContextHints: readonly string[] = [],
  followUpQueries: readonly string[] = [],
  map?: ProjectMap,
  worktreeStatus?: string,
  staleIndexWarning?: boolean,
): string {
  const cleanReason = reason.includes('preflight') ? 'deterministic' : reason.includes('LLM') ? 'llm' : reason
  const depsString = buildDepsString(extractions, map)

  const structured: StructuredOutput = {
    symbols: buildSymbolsTable(extractions),
    deps: depsString || undefined,
    confidence,
    reason: cleanReason,
    hints: missingContextHints.length > 0 ? missingContextHints.join(';') : undefined,
    queries: followUpQueries.length > 0
      ? followUpQueries
          .map((q) => q.replace(/^trace_symbol:\s*/, ''))
          .slice(0, MAX_FOLLOW_UP_QUERIES)
          .join(',')
      : undefined,
    worktreeStatus,
    staleIndexWarning,
  }

  return JSON.stringify({ markdown, structuredContent: structured })
}
