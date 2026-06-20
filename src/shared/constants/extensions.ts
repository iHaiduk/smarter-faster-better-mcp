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

export function getSourceExtensions(parserMode: ParserMode): ReadonlySet<string> {
  return parserMode === 'tree-sitter' ? TREE_SITTER_SOURCE_EXTENSIONS : OXC_SOURCE_EXTENSIONS
}

/** Returns true when the extension belongs to a JS/TS source file. */
export function isJsTsExtension(ext: string): boolean {
  return ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx'
}
