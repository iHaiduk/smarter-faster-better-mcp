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

export interface ProjectMap {
  readonly generatedAt: number
  readonly symbolsCount: number
  readonly symbols: readonly SymbolEntry[]
}

export interface LLMCandidate {
  readonly file: string
  readonly symbol: string
  readonly confidence: number
}

export interface LLMResponse {
  readonly candidates: readonly LLMCandidate[]
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

export interface AstProgram extends AstNode {
  type: 'Program'
  body: AstNode[]
}

export interface AstImportDeclaration extends AstNode {
  type: 'ImportDeclaration'
  source: { value: string } & AstNode
}

export const isAstNode = (value: unknown): value is AstNode =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'

export const isIdentifier = (value: unknown): value is AstIdentifier =>
  isAstNode(value) && value.type === 'Identifier' && typeof (value as { name?: unknown }).name === 'string'
