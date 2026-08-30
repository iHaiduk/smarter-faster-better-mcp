// Refactored: 2026-05-21 — modern JS/TS

export const SYMBOL_KINDS = [
  'FunctionDeclaration',
  'ClassDeclaration',
  'MethodDefinition',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'ArrowFunctionExpression',
  'JSONProperty',
  'StructDeclaration',
  'InterfaceDeclaration',
  'TypeDeclaration',
] as const

export type SymbolKind = (typeof SYMBOL_KINDS)[number]

export interface SymbolEntry {
  readonly name: string
  readonly file: string
  readonly line: number
  readonly kind: SymbolKind
  readonly signature: string
  readonly doc: string
}

export interface FileImportSpecifier {
  readonly local: string
  readonly imported: string
}

export interface FileImport {
  readonly source: string
  readonly resolved: string | null
  readonly specifiers: readonly FileImportSpecifier[]
}

export interface FileExport {
  readonly name: string
  readonly local: string
}

export interface FileReExport {
  readonly source: string
  readonly resolved: string | null
  readonly specifiers: readonly FileImportSpecifier[]
}

export interface FileMetadata {
  readonly file: string
  readonly imports: readonly FileImport[]
  readonly exports: readonly FileExport[]
  readonly reExports: readonly FileReExport[]
  readonly declarations: readonly string[]
}

export interface ProjectMap {
  readonly generatedAt: number
  readonly parserMode?: ParserMode
  readonly symbolsCount: number
  readonly symbols: readonly SymbolEntry[]
  readonly files?: readonly FileMetadata[]
}

export interface LLMCandidate {
  readonly file: string
  readonly symbol: string
  readonly confidence: number
  readonly tier?: RelevanceTier
}

export type RelevanceTier = 'mustRead' | 'likelyRelevant' | 'dependencyOnly' | 'testsOrExamples' | 'excluded'

export type ParserMode = 'oxc' | 'tree-sitter' | 'auto'

export interface CandidateRange {
  readonly startLine: number
  readonly endLine: number
}

export interface ExtractedSymbol {
  candidate: LLMCandidate
  code: string
  signature: string
  doc: string
  imports: readonly string[]
  importedBy: readonly string[]
  extractionOk: boolean
  startLine?: number
  endLine?: number
  typeDefs?: readonly string[]
  fullLength?: number
  relevanceTier?: RelevanceTier
  candidateRanges?: readonly CandidateRange[]
}

export interface ContextBudgetOptions {
  readonly maxFiles?: number
  readonly maxSymbols?: number
  readonly maxChars?: number
  readonly includeTests?: boolean
}

export interface StructuredOutput {
  readonly symbols: string
  readonly deps?: string
  readonly confidence: number
  readonly reason: string
  readonly hints?: string
  readonly queries?: string
  readonly worktreeStatus?: string
  readonly staleIndexWarning?: boolean
}

export interface ScoutConfig {
  readonly baseUrl?: string
  readonly apiKey?: string
  readonly model?: string
  readonly llmTimeoutMs: number
  readonly llmParallelism: number
  readonly parser: ParserMode
}

export type QueryIntent = 'specificSymbol' | 'featureSearch' | 'conceptSearch' | 'fileSearch'

export interface QueryAnalysis {
  readonly intent: QueryIntent
  readonly symbolNames: readonly string[]
  readonly expandedTerms: readonly string[]
  readonly filePatterns: readonly string[]
  readonly description: string
}

// Minimal structural typing for oxc-parser AST nodes — the parser returns
// loosely-typed JSON-like trees, so we narrow with type guards at call sites.
export interface AstNode {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

export interface AstIdentifier extends AstNode {
  type: 'Identifier'
  name: string
}

export const isAstNode = (value: unknown): value is AstNode =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'

export const isIdentifier = (value: unknown): value is AstIdentifier =>
  isAstNode(value) && value.type === 'Identifier' && typeof (value as { name?: unknown }).name === 'string'

export type DeadCodeType = 'dead_file' | 'dead_export' | 'dead_symbol'

export interface DeadCodeItem {
  readonly type: DeadCodeType
  readonly file: string
  readonly name: string
  readonly line?: number
  readonly kind?: string
  readonly confidence: number
  readonly reason: string
}

export interface DeadCodeReport {
  readonly summary: {
    readonly totalFilesScanned: number
    readonly deadFilesCount: number
    readonly deadExportsCount: number
    readonly deadSymbolsCount: number
    readonly entrypointsCount: number
  }
  readonly entrypoints: readonly string[]
  readonly deadFiles: readonly DeadCodeItem[]
  readonly deadExports: readonly DeadCodeItem[]
  readonly deadSymbols: readonly DeadCodeItem[]
}

export interface SubsystemCluster {
  readonly id: number
  readonly name: string
  readonly dominantDir: string
  readonly files: readonly string[]
  readonly internalEdgeWeight: number
  readonly totalEdgeWeight: number
  readonly cohesion: number
  readonly topKeywords: readonly string[]
}

export interface SubsystemMetrics {
  readonly modularity: number
  readonly clustersCount: number
  readonly totalNodes: number
  readonly totalEdges: number
  readonly clusters: readonly SubsystemCluster[]
  readonly interClusterDependencies: readonly {
    readonly fromCluster: number
    readonly toCluster: number
    readonly weight: number
  }[]
}

