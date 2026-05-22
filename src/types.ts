// Refactored: 2026-05-21 — modern JS/TS

export const SYMBOL_KINDS = [
  'FunctionDeclaration',
  'ClassDeclaration',
  'MethodDefinition',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'ArrowFunctionExpression',
  'JSONProperty',
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
}

export interface ScoutConfig {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly llmTimeoutMs: number
  readonly confidenceThreshold: number
  readonly llmParallelism: number
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
