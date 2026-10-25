import * as path from 'node:path'
import * as fs from 'node:fs'

import { getParserEngineForFile } from '../shared/constants/extensions.js'
import { getMapFilePath } from '../config/index.js'
import { renderSymbolOutline } from '../pipeline/index.js'
import { parseFile } from '../indexing/parser/oxc-walker.js'
import type { ProjectMap, SymbolEntry } from '../shared/types/index.js'

export interface ContextGateResult {
  readonly exitCode: 0 | 1 | 3
  readonly output?: string
}

export function findWorkspaceRoot(absFile: string): string {
  let current = path.dirname(absFile)
  const root = path.parse(current).root
  while (current !== root) {
    if (
      fs.existsSync(path.join(current, '.git')) ||
      fs.existsSync(path.join(current, 'package.json'))
    ) {
      return current
    }
    current = path.dirname(current)
  }
  return path.dirname(absFile)
}

export async function runContextGate(inputPath?: string): Promise<ContextGateResult> {
  if (!inputPath || typeof inputPath !== 'string' || inputPath.trim().length === 0) {
    return { exitCode: 1 }
  }

  const absPath = path.isAbsolute(inputPath)
    ? path.normalize(inputPath)
    : path.resolve(process.cwd(), inputPath)

  if (!fs.existsSync(absPath)) {
    return { exitCode: 1 }
  }

  let stats: fs.Stats
  try {
    stats = fs.statSync(absPath)
  } catch {
    return { exitCode: 1 }
  }

  if (stats.isDirectory()) {
    return { exitCode: 1 }
  }

  const engine = getParserEngineForFile(absPath)
  if (!engine) {
    return { exitCode: 1 }
  }

  let rawContent: string
  try {
    rawContent = fs.readFileSync(absPath, 'utf8')
  } catch {
    return { exitCode: 1 }
  }

  const rawSize = Buffer.byteLength(rawContent, 'utf8')
  if (rawSize === 0) {
    return { exitCode: 3 }
  }

  const workspaceRoot = findWorkspaceRoot(absPath)
  const relPath = path.relative(workspaceRoot, absPath)

  let symbols: SymbolEntry[] = []
  let imports: string[] = []
  let importedBy: string[] = []

  const mapPath = getMapFilePath(workspaceRoot)
  if (fs.existsSync(mapPath)) {
    try {
      const rawMap = fs.readFileSync(mapPath, 'utf8')
      const map = JSON.parse(rawMap) as ProjectMap
      if (map && Array.isArray(map.symbols)) {
        symbols = map.symbols.filter((s) => s.file === relPath)
        const fileMeta = map.files?.find((f) => f.file === relPath)
        if (fileMeta) {
          imports = fileMeta.imports.map((i) => i.source)
        }
        if (map.files) {
          const baseName = path.basename(relPath, path.extname(relPath))
          importedBy = map.files
            .filter(
              (f) =>
                f.file !== relPath &&
                f.imports.some(
                  (imp) => imp.resolved === relPath || imp.source.includes(baseName),
                ),
            )
            .map((f) => f.file)
        }
      }
    } catch {
      // ignore map cache read failure
    }
  }

  if (symbols.length === 0) {
    try {
      const parseRes = await parseFile(relPath, workspaceRoot, 'auto')
      symbols = parseRes.symbols
      imports = parseRes.metadata.imports.map((i) => i.source)
    } catch {
      return { exitCode: 3 }
    }
  }

  if (symbols.length === 0) {
    return { exitCode: 3 }
  }

  const sorted = [...symbols].sort((a, b) => a.line - b.line)
  const totalLines = rawContent.split(/\r?\n/).length

  const symbolsWithRanges = sorted.map((s, idx) => {
    const next = sorted[idx + 1]
    const startLine = s.line
    const endLine = next ? Math.max(startLine, next.line - 1) : totalLines
    const lineCount = endLine - startLine + 1
    const prefix = lineCount > 1 ? `// [folded ${lineCount} lines] ` : ''
    return {
      name: s.name,
      signature: prefix ? `${prefix}${s.signature || s.name}` : (s.signature || s.name),
      startLine,
      endLine,
    }
  })

  const noteParts: string[] = []
  if (imports.length > 0) {
    noteParts.push(`Imports: ${imports.slice(0, 10).join(', ')}`)
  }
  if (importedBy.length > 0) {
    noteParts.push(`Used by: ${importedBy.slice(0, 10).join(', ')}`)
  }

  const note = noteParts.length > 0 ? noteParts.join('\n') : undefined
  const outlineMarkdown = renderSymbolOutline(relPath, symbolsWithRanges, note)

  const compressedSize = Buffer.byteLength(outlineMarkdown, 'utf8')
  if (compressedSize >= rawSize) {
    return { exitCode: 3 }
  }

  return {
    exitCode: 0,
    output: outlineMarkdown,
  }
}

if (
  process.argv[1]?.endsWith('context.js') ||
  process.argv[1]?.endsWith('context.ts') ||
  process.argv[1]?.endsWith('context')
) {
  const result = await runContextGate(process.argv[2])
  if (result.exitCode === 0 && result.output) {
    process.stdout.write(result.output + '\n')
  }
  process.exit(result.exitCode)
}
