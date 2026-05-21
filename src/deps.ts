// Refactored: 2026-05-21 — modern JS/TS
// Finds files referencing a symbol using ripgrep --word-regexp.
// Skips noisy short names (e.g., "Map", "Set") that would generate
// false positives without semantic resolution.

interface RgMatchLine {
  readonly type: string
  readonly data?: { readonly path?: { readonly text?: string } }
}

const MAX_DEP_FILES = 5
const MIN_SYMBOL_LENGTH = 4

// Names too common in any JS/TS codebase — searching them yields noise.
const NOISY_NAMES: ReadonlySet<string> = new Set([
  'Map', 'Set', 'Array', 'Object', 'String', 'Number', 'Boolean',
  'Date', 'Error', 'Promise', 'JSON', 'Math', 'URL', 'User', 'Data',
  'Item', 'Node', 'List', 'Type', 'Value', 'Key', 'Name', 'Result',
])

function isNoisy(symbol: string): boolean {
  return symbol.length < MIN_SYMBOL_LENGTH || NOISY_NAMES.has(symbol)
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Returns up to 5 files (excluding `excludeFile`) referencing `symbolName` as a whole word. */
export async function findDeps(symbolName: string, excludeFile: string): Promise<string[]> {
  if (isNoisy(symbolName)) return []

  try {
    const proc = Bun.spawn(
      [
        'rg', '--json',
        '--word-regexp',
        '-l',
        '--type', 'ts',
        '--glob', '!node_modules',
        '--glob', '!dist',
        '--glob', '!build',
        '--', symbolName, '.',
      ],
      { stdout: 'pipe', stderr: 'ignore', cwd: process.cwd() },
    )

    const out = await new Response(proc.stdout).text()
    const seen = new Set<string>()

    for (const line of out.split('\n')) {
      if (!line) continue
      const parsed = safeJsonParse<RgMatchLine>(line)
      const text = parsed?.type === 'match' ? parsed.data?.path?.text : undefined
      if (text && text !== excludeFile) seen.add(text)
      if (seen.size >= MAX_DEP_FILES) break
    }

    return [...seen]
  } catch {
    console.error(`[Scout] rg not available, skipping deps for ${symbolName}`)
    return []
  }
}
