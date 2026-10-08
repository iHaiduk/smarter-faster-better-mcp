import type { ParserMode } from '../types/index.js'

export const OXC_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json',
])

export const TREE_SITTER_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json',
  '.py', '.go', '.dart', '.rs', '.rb',
  '.java', '.cpp', '.cc', '.cxx', '.h', '.hpp',
  '.c', '.cs', '.php',
])

export const ALL_SUPPORTED_EXTENSIONS: ReadonlySet<string> = TREE_SITTER_SOURCE_EXTENSIONS

export function getSourceExtensions(_parserMode?: ParserMode): ReadonlySet<string> {
  return ALL_SUPPORTED_EXTENSIONS
}

/** File parser engine dispatched dynamically based on file type. */
export type ParserEngine = 'oxc' | 'tree-sitter' | 'json'

export function isTreeSitterSupportedExtension(ext: string): boolean {
  return TREE_SITTER_SOURCE_EXTENSIONS.has(ext)
}

/** Returns true when the extension belongs to a JS/TS source file. */
export function isJsTsExtension(ext: string): boolean {
  return ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx'
}

/**
 * Dynamically resolves the parser engine for a given file based on its extension:
 * - JSON files -> 'json'
 * - JS/TS files -> 'oxc' (ultra-fast Rust/OXC parser)
 * - Other code files (.py, .go, .rs, .dart, .java, .cpp, .c, .cs, .rb, .php) -> 'tree-sitter'
 */
export function getParserEngineForFile(
  filePath: string,
  _parserMode?: ParserMode,
): ParserEngine | null {
  const ext = (filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '').toLowerCase()
  if (ext === '.json') return 'json'
  if (isJsTsExtension(ext)) return 'oxc'
  if (isTreeSitterSupportedExtension(ext)) return 'tree-sitter'
  return null
}


