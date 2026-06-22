import * as path from 'node:path'
import * as fs from 'node:fs/promises'

import { getParserMode } from '../config/index.js'
import { shouldIgnorePath } from '../shared/constants/ignore-rules.js'
import { getProjectFiles } from '../indexing/symbol-map/build-map.js'
import { fileExists } from '../shared/utils/node.js'

import type { SymbolEntry, SymbolKind } from '../shared/types/index.js'

/**
 * Regex patterns for detecting symbol declarations in source code.
 * Matches: function Name, const Name =, class Name, type Name =, interface Name, etc.
 */
const DECLARATION_PATTERNS: ReadonlyArray<{ regex: RegExp; kind: SymbolKind }> = [
  { regex: /\bfunction\s+([a-zA-Z_$][\w$]*)\s*\(/g, kind: 'FunctionDeclaration' },
  { regex: /\bclass\s+([a-zA-Z_$][\w$]*)\b/g, kind: 'ClassDeclaration' },
  { regex: /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g, kind: 'ArrowFunctionExpression' },
  { regex: /\b(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?function\b/g, kind: 'FunctionDeclaration' },
  { regex: /\binterface\s+([a-zA-Z_$][\w$]*)\b/g, kind: 'TSInterfaceDeclaration' },
  { regex: /\btype\s+([a-zA-Z_$][\w$]*)\s*=/g, kind: 'TSTypeAliasDeclaration' },
  { regex: /\bexport\s+(?:default\s+)?function\s+([a-zA-Z_$][\w$]*)\s*\(/g, kind: 'FunctionDeclaration' },
  { regex: /\bexport\s+(?:default\s+)?class\s+([a-zA-Z_$][\w$]*)\b/g, kind: 'ClassDeclaration' },
  { regex: /\bexport\s+(?:default\s+)?(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=/g, kind: 'ArrowFunctionExpression' },
  { regex: /\bexport\s+\{([^}]+)\}/g, kind: 'FunctionDeclaration' },
]

/** Maximum number of files to scan in filesystem fallback. */
const MAX_FS_SCAN_FILES = 200

/** Maximum file size to scan (1MB). */
const MAX_FILE_BYTES = 1_000_000

interface FsSymbolMatch {
  readonly file: string
  readonly name: string
  readonly kind: SymbolKind
  readonly line: number
}

/**
 * Quick filesystem search for symbol declarations.
 * Used as a fallback when the project map doesn't contain a symbol.
 * Scans source files for declaration patterns matching the given names.
 *
 * @param symbolNames - Exact symbol names to search for
 * @param targetRoot - Project root directory
 * @returns Array of found symbol matches
 */
export async function filesystemSymbolSearch(
  symbolNames: readonly string[],
  targetRoot: string,
): Promise<readonly FsSymbolMatch[]> {
  if (symbolNames.length === 0) return []

  const parserMode = getParserMode()
  const files = await getProjectFiles(targetRoot, parserMode)
  const nameSet = new Set(symbolNames)
  const matches: FsSymbolMatch[] = []

  let scanned = 0
  for (const file of files) {
    if (scanned >= MAX_FS_SCAN_FILES) break
    if (shouldIgnorePath(file)) continue

    const absPath = path.join(targetRoot, file)
    if (!(await fileExists(absPath))) continue

    let stat
    try {
      stat = await fs.stat(absPath)
    } catch {
      continue
    }
    if (stat.size === 0 || stat.size > MAX_FILE_BYTES) continue

    let source: string
    try {
      source = await fs.readFile(absPath, 'utf8')
    } catch {
      continue
    }

    scanned++

    const lines = source.split('\n')
    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx]!
      for (const { regex, kind } of DECLARATION_PATTERNS) {
        // Reset regex state for each line
        regex.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = regex.exec(line)) !== null) {
          const name = match[1]?.trim()
          if (name && nameSet.has(name)) {
            // Handle export { name1, name2 } patterns
            if (line.includes('export') && line.includes('{') && !line.includes('function') && !line.includes('class')) {
              const exportedNames = line.match(/\b([a-zA-Z_$][\w$]*)\b/g) ?? []
              for (const expName of exportedNames) {
                if (nameSet.has(expName)) {
                  matches.push({ file, name: expName, kind, line: lineIdx + 1 })
                }
              }
            } else {
              matches.push({ file, name, kind, line: lineIdx + 1 })
            }
          }
        }
      }
    }
  }

  return matches
}

/**
 * Converts filesystem symbol matches to SymbolEntry format for map integration.
 */
export function fsMatchesToSymbolEntries(matches: readonly FsSymbolMatch[]): SymbolEntry[] {
  return matches.map((m) => ({
    name: m.name,
    file: m.file,
    line: m.line,
    kind: m.kind,
    signature: '',
    doc: '',
  }))
}
