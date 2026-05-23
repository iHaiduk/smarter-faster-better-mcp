/** Strips JS/TS comments from a JSON-like source string so `JSON.parse` succeeds. */
export function cleanJsonText(text: string): string {
  return text.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, (m, str, p2) =>
    str ? str : (p2 ?? ''),
  )
}

import type { SymbolEntry } from '../../types.js'

function parseJsonFile(source: string, relPath: string): SymbolEntry[] {
  try {
    const clean = cleanJsonText(source)
    const parsed = JSON.parse(clean)
    if (typeof parsed !== 'object' || parsed === null) return []
    const symbols: SymbolEntry[] = []
    for (const [key, value] of Object.entries(parsed)) {
      symbols.push({
        name: key,
        file: relPath,
        line: 1,
        kind: 'JSONProperty',
        signature: `"${key}": ${Array.isArray(value) ? 'Array' : typeof value}`,
        doc: '',
      })
    }
    return symbols
  } catch (err) {
    console.error(`[Scout] Failed to parse JSON ${relPath}:`, err)
    return []
  }
}

export { parseJsonFile }
