// Refactored: 2026-05-21 — modern JS/TS
import * as path from 'node:path'

import { parseSync } from 'oxc-parser'

import { extractName, getLineFromOffset, walkAst } from './ast.js'
import { clearL1 } from './cache.js'
import { MAP_FILE, MAX_SYMBOLS, PARSE_CHUNK_SIZE } from './config.js'
import { isAstNode, isIdentifier, SYMBOL_KINDS } from './types.js'

import type { AstNode, ProjectMap, SymbolEntry, SymbolKind } from './types.js'

const RELEVANT_KINDS: ReadonlySet<SymbolKind> = new Set(SYMBOL_KINDS)

const IGNORE_PATTERNS = [
  'node_modules/', '.git/', 'dist/', 'build/', 'coverage/',
] as const

const IGNORE_SUFFIXES = [
  '.d.ts', '.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx',
  '.test.js', '.spec.js', '.test.jsx', '.spec.jsx',
  'package-lock.json'
] as const

function shouldSkipFile(file: string): boolean {
  return (
    IGNORE_PATTERNS.some((prefix) => file.startsWith(prefix)) ||
    IGNORE_SUFFIXES.some((suffix) => file.endsWith(suffix))
  )
}

/** Lists relative paths of source files under cwd, skipping noise. */
export async function getProjectFiles(): Promise<string[]> {
  const glob = new Bun.Glob('**/*.{ts,tsx,js,jsx,json}')
  const files: string[] = []
  for await (const file of glob.scan({ cwd: process.cwd(), onlyFiles: true })) {
    if (!shouldSkipFile(file)) files.push(file)
  }
  return files
}

/** Extracts the JSDoc block immediately preceding a symbol's start offset. */
export function extractJSDoc(source: string, symbolStart: number): string {
  const before = source.slice(0, symbolStart)
  const match = before.match(/\/\*\*([\s\S]*?)\*\/\s*$/)
  if (!match?.[1]) return ''
  return match[1]
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 300)
}

function buildSignature(text: string): string {
  const bodyStart = text.indexOf('{')
  const head = bodyStart > 0 ? text.slice(0, bodyStart) : text.split('\n')[0] ?? ''
  return head.trim().replace(/\s+/g, ' ').slice(0, 200)
}

function makeSymbol(
  node: AstNode,
  source: string,
  relPath: string,
  kind: SymbolKind,
): SymbolEntry | null {
  const name = extractName(node)
  if (!name) return null
  const fullText = source.substring(node.start, node.end)
  return {
    name,
    file: relPath,
    line: getLineFromOffset(source, node.start),
    kind,
    signature: buildSignature(fullText),
    doc: extractJSDoc(source, node.start),
  }
}

function isVariableDeclarationNode(
  node: AstNode,
): node is AstNode & { declarations: AstNode[] } {
  return node.type === 'VariableDeclaration' && Array.isArray(node['declarations'])
}

function collectArrowSymbols(
  node: AstNode & { declarations: AstNode[] },
  source: string,
  relPath: string,
  out: SymbolEntry[],
): void {
  for (const decl of node.declarations) {
    if (!isAstNode(decl)) continue
    const id = decl['id']
    const init = decl['init']
    if (!isIdentifier(id) || !isAstNode(init) || init.type !== 'ArrowFunctionExpression') continue

    const fullText = source.substring(decl.start, decl.end)
    out.push({
      name: id.name,
      file: relPath,
      line: getLineFromOffset(source, decl.start),
      kind: 'ArrowFunctionExpression',
      signature: buildSignature(fullText),
      doc: extractJSDoc(source, node.start),
    })
  }
}

function parseJsonFile(source: string, relPath: string): SymbolEntry[] {
  try {
    const parsed = JSON.parse(source)
    if (typeof parsed !== 'object' || parsed === null) return []
    const symbols: SymbolEntry[] = []
    for (const [key, value] of Object.entries(parsed)) {
      symbols.push({
        name: key,
        file: relPath,
        line: 1,
        kind: 'JSONProperty',
        signature: `"${key}": ${Array.isArray(value) ? 'Array' : typeof value}`,
        doc: ''
      })
    }
    return symbols
  } catch (err) {
    console.error(`[Scout] Failed to parse JSON ${relPath}:`, err)
    return []
  }
}

/** Parses a TypeScript file and extracts a flat list of top-level symbols. */
export async function parseFile(relPath: string): Promise<SymbolEntry[]> {
  try {
    const source = await Bun.file(path.join(process.cwd(), relPath)).text()
    if (relPath.endsWith('.json')) {
      return parseJsonFile(source, relPath)
    }
    const parsed = parseSync(relPath, source)
    const symbols: SymbolEntry[] = []
    const program = parsed.program as unknown as AstNode

    walkAst(program, (node) => {
      if (RELEVANT_KINDS.has(node.type as SymbolKind)) {
        const sym = makeSymbol(node, source, relPath, node.type as SymbolKind)
        if (sym) symbols.push(sym)
        return
      }
      if (isVariableDeclarationNode(node)) {
        collectArrowSymbols(node, source, relPath, symbols)
      }
    })

    return symbols
  } catch (err) {
    console.error(`[Scout] Failed to parse ${relPath}:`, err)
    return []
  }
}

/** Builds and persists the project symbol map. */
export async function buildMap(): Promise<ProjectMap> {
  const files = await getProjectFiles()
  console.error(`[Scout] Building map for ${files.length} files...`)

  const allSymbols: SymbolEntry[] = []
  for (let i = 0; i < files.length; i += PARSE_CHUNK_SIZE) {
    const chunk = files.slice(i, i + PARSE_CHUNK_SIZE)
    const results = await Promise.all(chunk.map(parseFile))
    for (const list of results) allSymbols.push(...list)
  }

  if (allSymbols.length > MAX_SYMBOLS) {
    console.error(`[Scout] Truncating ${allSymbols.length} → ${MAX_SYMBOLS} symbols`)
  }

  const map: ProjectMap = {
    generatedAt: Date.now(),
    symbolsCount: Math.min(allSymbols.length, MAX_SYMBOLS),
    symbols: allSymbols.slice(0, MAX_SYMBOLS),
  }

  await Bun.write(MAP_FILE, JSON.stringify(map))
  clearL1()
  console.error(`[Scout] Map built: ${map.symbolsCount} symbols`)
  return map
}
