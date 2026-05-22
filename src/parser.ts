import * as path from 'node:path'

import { parseSync } from 'oxc-parser'

import { extractName, getLineFromOffset, walkAst } from './ast.js'
import { clearL1 } from './cache.js'
import { getMapFilePath, MAX_SYMBOLS, PARSE_CHUNK_SIZE } from './config.js'
import { isAstNode, isIdentifier, SYMBOL_KINDS } from './types.js'

import type {
  AstNode,
  ProjectMap,
  SymbolEntry,
  SymbolKind,
  FileImport,
  FileExport,
  FileReExport,
  FileMetadata,
  FileImportSpecifier,
} from './types.js'

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

/** Lists relative paths of source files under targetRoot, skipping noise. */
export async function getProjectFiles(targetRoot: string): Promise<string[]> {
  const glob = new Bun.Glob('**/*.{ts,tsx,js,jsx,json}')
  const files: string[] = []
  for await (const file of glob.scan({ cwd: targetRoot, onlyFiles: true })) {
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

export function cleanJsonText(text: string): string {
  return text.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, (m, str, p2) =>
    str ? str : (p2 ?? ''),
  )
}

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
        doc: ''
      })
    }
    return symbols
  } catch (err) {
    console.error(`[Scout] Failed to parse JSON ${relPath}:`, err)
    return []
  }
}

export async function loadTsConfigPaths(
  targetRoot: string,
): Promise<{ baseUrl?: string; paths?: Record<string, string[]> }> {
  try {
    const tsconfigPath = path.join(targetRoot, 'tsconfig.json')
    const file = Bun.file(tsconfigPath)
    if (!(await file.exists())) return {}
    const text = await file.text()
    const cleanText = cleanJsonText(text)
    const json = JSON.parse(cleanText)
    return {
      baseUrl: json.compilerOptions?.baseUrl,
      paths: json.compilerOptions?.paths,
    }
  } catch {
    return {}
  }
}

export async function resolveModulePath(
  source: string,
  importingFileRel: string,
  targetRoot: string,
  paths: Record<string, string[]> | undefined,
  baseUrl: string | undefined,
): Promise<string | null> {
  const dir = path.dirname(importingFileRel)
  let resolved: string | null = null

  // 1. Resolve alias
  if (paths) {
    for (const [pattern, targets] of Object.entries(paths)) {
      const regexPattern = pattern.replace(/\*/g, '(.*)')
      const match = new RegExp(`^${regexPattern}$`).exec(source)
      if (match) {
        const subpath = match[1] ?? ''
        for (const target of targets) {
          const mappedTarget = target.replace(/\*/g, subpath)
          const baseDir = baseUrl ? path.join(targetRoot, baseUrl) : targetRoot
          const targetAbs = path.resolve(baseDir, mappedTarget)
          const rel = path.relative(targetRoot, targetAbs)
          resolved = rel
          break
        }
      }
      if (resolved) break
    }
  }

  // 2. Resolve relative
  if (!resolved && source.startsWith('.')) {
    resolved = path.join(dir, source)
  }

  if (!resolved) {
    return null
  }

  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.json', '.d.ts']

  let baseResolved = resolved
  if (resolved.endsWith('.js')) {
    baseResolved = resolved.slice(0, -3)
  } else if (resolved.endsWith('.jsx')) {
    baseResolved = resolved.slice(0, -4)
  } else if (resolved.endsWith('.ts')) {
    baseResolved = resolved.slice(0, -3)
  } else if (resolved.endsWith('.tsx')) {
    baseResolved = resolved.slice(0, -4)
  }

  // Try direct file extensions
  for (const r of [resolved, baseResolved]) {
    for (const ext of ['', ...extensions]) {
      const candidate = ext ? `${r}${ext}` : r
      const absCandidate = path.join(targetRoot, candidate)
      if (await Bun.file(absCandidate).exists()) {
        try {
          const stat = await Bun.file(absCandidate).stat()
          if (stat.isDirectory()) continue
        } catch {}
        return candidate
      }
    }
  }

  // Try index files (barrel exports)
  for (const ext of extensions) {
    const indexCandidate = path.join(resolved, `index${ext}`)
    const absCandidate = path.join(targetRoot, indexCandidate)
    if (await Bun.file(absCandidate).exists()) {
      return indexCandidate
    }
  }

  return null
}

/** Parses a TypeScript file and extracts top-level symbols + import graph metadata. */
export async function parseFile(
  relPath: string,
  targetRoot: string,
  tsPaths?: Record<string, string[]>,
  tsBaseUrl?: string,
): Promise<{ symbols: SymbolEntry[]; metadata: FileMetadata }> {
  const symbols: SymbolEntry[] = []
  const fileImports: FileImport[] = []
  const fileExports: FileExport[] = []
  const fileReExports: FileReExport[] = []
  const declarations: string[] = []

  const defaultMeta: FileMetadata = {
    file: relPath,
    imports: [],
    exports: [],
    reExports: [],
    declarations: [],
  }

  try {
    const sourcePath = path.join(targetRoot, relPath)
    const source = await Bun.file(sourcePath).text()

    if (relPath.endsWith('.json')) {
      const jsonSymbols = parseJsonFile(source, relPath)
      const clean = cleanJsonText(source)
      const keys = Object.keys(JSON.parse(clean) || {})
      return {
        symbols: jsonSymbols,
        metadata: {
          file: relPath,
          imports: [],
          exports: keys.map((k) => ({ name: k, local: k })),
          reExports: [],
          declarations: keys,
        },
      }
    }

    const parsed = parseSync(relPath, source)
    const program = parsed.program as unknown as AstNode

    // 1. Walk AST for SymbolEntries
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

    // 2. Parse top-level structures in program.body for imports, exports, and declarations
    if (program && Array.isArray(program.body)) {
      for (const statement of program.body) {
        if (!isAstNode(statement)) continue

        // --- Declarations ---
        const localDeclNames: string[] = []
        if (
          statement.type === 'FunctionDeclaration' ||
          statement.type === 'ClassDeclaration' ||
          statement.type === 'TSInterfaceDeclaration' ||
          statement.type === 'TSTypeAliasDeclaration'
        ) {
          const name = extractName(statement)
          if (name) {
            declarations.push(name)
            localDeclNames.push(name)
          }
        } else if (statement.type === 'VariableDeclaration') {
          const decls = statement['declarations']
          if (Array.isArray(decls)) {
            for (const decl of decls) {
              if (isAstNode(decl) && isIdentifier(decl['id'])) {
                declarations.push(decl['id'].name)
                localDeclNames.push(decl['id'].name)
              }
            }
          }
        }

        // --- Imports ---
        if (statement.type === 'ImportDeclaration') {
          const srcNode = statement['source'] as { value: string }
          if (srcNode && typeof srcNode.value === 'string') {
            const specList: FileImportSpecifier[] = []
            const specs = statement['specifiers']
            if (Array.isArray(specs)) {
              for (const spec of specs) {
                if (!isAstNode(spec)) continue
                if (spec.type === 'ImportSpecifier') {
                  const imported = (spec['imported'] as { name?: string })?.name ?? ''
                  const local = (spec['local'] as { name?: string })?.name ?? ''
                  if (imported && local) specList.push({ local, imported })
                } else if (spec.type === 'ImportDefaultSpecifier') {
                  const local = (spec['local'] as { name?: string })?.name ?? ''
                  if (local) specList.push({ local, imported: 'default' })
                } else if (spec.type === 'ImportNamespaceSpecifier') {
                  const local = (spec['local'] as { name?: string })?.name ?? ''
                  if (local) specList.push({ local, imported: '*' })
                }
              }
            }
            const resolved = await resolveModulePath(srcNode.value, relPath, targetRoot, tsPaths, tsBaseUrl)
            fileImports.push({
              source: srcNode.value,
              resolved,
              specifiers: specList,
            })
          }
        }

        // --- Exports & Re-exports ---
        if (statement.type === 'ExportNamedDeclaration') {
          const srcNode = statement['source'] as { value: string } | null
          if (srcNode && typeof srcNode.value === 'string') {
            const specList: FileImportSpecifier[] = []
            const specs = statement['specifiers']
            if (Array.isArray(specs)) {
              for (const spec of specs) {
                if (!isAstNode(spec)) continue
                if (spec.type === 'ExportSpecifier') {
                  const localName = (spec['local'] as { name?: string })?.name ?? ''
                  const exportedName = (spec['exported'] as { name?: string })?.name ?? ''
                  if (localName && exportedName) {
                    specList.push({
                      local: exportedName,
                      imported: localName,
                    })
                  }
                }
              }
            }
            const resolved = await resolveModulePath(srcNode.value, relPath, targetRoot, tsPaths, tsBaseUrl)
            fileReExports.push({
              source: srcNode.value,
              resolved,
              specifiers: specList,
            })
          } else {
            const decl = statement['declaration']
            if (isAstNode(decl)) {
              for (const name of localDeclNames) {
                fileExports.push({ name, local: name })
              }
            }
            const specs = statement['specifiers']
            if (Array.isArray(specs)) {
              for (const spec of specs) {
                if (!isAstNode(spec)) continue
                if (spec.type === 'ExportSpecifier') {
                  const localName = (spec['local'] as { name?: string })?.name ?? ''
                  const exportedName = (spec['exported'] as { name?: string })?.name ?? ''
                  if (localName && exportedName) {
                    fileExports.push({ name: exportedName, local: localName })
                  }
                }
              }
            }
          }
        } else if (statement.type === 'ExportAllDeclaration') {
          const srcNode = statement['source'] as { value: string }
          if (srcNode && typeof srcNode.value === 'string') {
            const resolved = await resolveModulePath(srcNode.value, relPath, targetRoot, tsPaths, tsBaseUrl)
            fileReExports.push({
              source: srcNode.value,
              resolved,
              specifiers: [],
            })
          }
        } else if (statement.type === 'ExportDefaultDeclaration') {
          const decl = statement['declaration']
          let localName = 'default'
          if (isAstNode(decl)) {
            const name = extractName(decl)
            if (name) localName = name
          }
          fileExports.push({ name: 'default', local: localName })
        }
      }
    }

    return {
      symbols,
      metadata: {
        file: relPath,
        imports: fileImports,
        exports: fileExports,
        reExports: fileReExports,
        declarations,
      },
    }
  } catch (err) {
    console.error(`[Scout] Failed to parse ${relPath}:`, err)
    return { symbols: [], metadata: defaultMeta }
  }
}

/** Builds and persists the project symbol map and import graph. */
export async function buildMap(targetRoot = process.cwd()): Promise<ProjectMap> {
  const files = await getProjectFiles(targetRoot)
  console.error(`[Scout] Building map for ${files.length} files under ${targetRoot}...`)

  const tsconfig = await loadTsConfigPaths(targetRoot)

  const allSymbols: SymbolEntry[] = []
  const filesMetadata: FileMetadata[] = []

  for (let i = 0; i < files.length; i += PARSE_CHUNK_SIZE) {
    const chunk = files.slice(i, i + PARSE_CHUNK_SIZE)
    const results = await Promise.all(
      chunk.map((f) => parseFile(f, targetRoot, tsconfig.paths, tsconfig.baseUrl)),
    )
    for (const res of results) {
      allSymbols.push(...res.symbols)
      filesMetadata.push(res.metadata)
    }
  }

  if (allSymbols.length > MAX_SYMBOLS) {
    console.error(`[Scout] Truncating ${allSymbols.length} → ${MAX_SYMBOLS} symbols`)
  }

  const map: ProjectMap = {
    generatedAt: Date.now(),
    symbolsCount: Math.min(allSymbols.length, MAX_SYMBOLS),
    symbols: allSymbols.slice(0, MAX_SYMBOLS),
    files: filesMetadata,
  }

  clearL1()
  await Bun.write(getMapFilePath(targetRoot), JSON.stringify(map))
  console.error(`[Scout] Map built: ${map.symbolsCount} symbols`)
  return map
}
