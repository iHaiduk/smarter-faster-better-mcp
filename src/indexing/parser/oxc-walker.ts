import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { parseSync } from 'oxc-parser'

import { extractName, getLineFromOffset, walkAst } from '../../shared/utils/ast.js'
import { getParserMode } from '../../config/index.js'
import { extractJSDoc, buildSignature } from './jsdoc.js'
import { cleanJsonText, parseJsonFile } from './json-parser.js'
import { parseFileWithTreeSitter } from './tree-sitter-walker.js'
import { resolveModulePath } from '../resolver/module-resolver.js'
import { isAstNode, isIdentifier, SYMBOL_KINDS } from '../../shared/types/index.js'
import { fileExists } from '../../shared/utils/node.js'

import type {
  AstNode,
  FileExport,
  FileImport,
  FileImportSpecifier,
  FileMetadata,
  FileReExport,
  ParserMode,
  SymbolEntry,
  SymbolKind,
} from '../../shared/types/index.js'

const RELEVANT_KINDS: ReadonlySet<SymbolKind> = new Set(SYMBOL_KINDS)

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

async function parseImportDeclaration(
  statement: AstNode,
  relPath: string,
  targetRoot: string,
  tsPaths?: Record<string, string[]>,
  tsBaseUrl?: string,
): Promise<FileImport | null> {
  const srcNode = statement['source'] as { value: string } | undefined
  if (!srcNode || typeof srcNode.value !== 'string') return null

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
  return { source: srcNode.value, resolved, specifiers: specList }
}

async function parseExportNamedDeclaration(
  statement: AstNode,
  localDeclNames: readonly string[],
  relPath: string,
  targetRoot: string,
  tsPaths?: Record<string, string[]>,
  tsBaseUrl?: string,
): Promise<{ exports: FileExport[]; reExports: FileReExport[] }> {
  const srcNode = statement['source'] as { value: string } | null

  if (srcNode && typeof srcNode.value === 'string') {
    const specList: FileImportSpecifier[] = []
    const specs = statement['specifiers']
    if (Array.isArray(specs)) {
      for (const spec of specs) {
        if (!isAstNode(spec) || spec.type !== 'ExportSpecifier') continue
        const localName = (spec['local'] as { name?: string })?.name ?? ''
        const exportedName = (spec['exported'] as { name?: string })?.name ?? ''
        if (localName && exportedName) specList.push({ local: exportedName, imported: localName })
      }
    }
    const resolved = await resolveModulePath(srcNode.value, relPath, targetRoot, tsPaths, tsBaseUrl)
    return { exports: [], reExports: [{ source: srcNode.value, resolved, specifiers: specList }] }
  }

  const namedExports: FileExport[] = []
  const decl = statement['declaration']
  if (isAstNode(decl)) {
    for (const name of localDeclNames) namedExports.push({ name, local: name })
  }

  const specs = statement['specifiers']
  if (Array.isArray(specs)) {
    for (const spec of specs) {
      if (!isAstNode(spec) || spec.type !== 'ExportSpecifier') continue
      const localName = (spec['local'] as { name?: string })?.name ?? ''
      const exportedName = (spec['exported'] as { name?: string })?.name ?? ''
      if (localName && exportedName) namedExports.push({ name: exportedName, local: localName })
    }
  }

  return { exports: namedExports, reExports: [] }
}

/** Parses a source file and extracts top-level symbols + import graph metadata. */
export async function parseFile(
  relPath: string,
  targetRoot: string,
  parserMode: ParserMode = getParserMode(),
  tsPaths?: Record<string, string[]>,
  tsBaseUrl?: string,
): Promise<{ symbols: SymbolEntry[]; metadata: FileMetadata }> {
  const defaultMeta: FileMetadata = {
    file: relPath,
    imports: [],
    exports: [],
    reExports: [],
    declarations: [],
  }

  try {
    const sourcePath = path.join(targetRoot, relPath)
    if (!(await fileExists(sourcePath))) return { symbols: [], metadata: defaultMeta }
    const source = await fs.readFile(sourcePath, 'utf8')

    if (relPath.endsWith('.json')) {
      const jsonSymbols = parseJsonFile(source, relPath)
      const clean = cleanJsonText(source)
      let keys: string[] = []
      try {
        const parsed = JSON.parse(clean)
        keys = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? Object.keys(parsed as object)
          : []
      } catch {
        // malformed JSON — emit symbols without export metadata
      }
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

    const ext = path.extname(relPath).toLowerCase()
    const isJsTs = ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx'

    if (!isJsTs) {
      if (parserMode !== 'tree-sitter') return { symbols: [], metadata: defaultMeta }
      return await parseFileWithTreeSitter(source, relPath, ext)
    }

    const parsed = parseSync(relPath, source)
    const program = parsed.program as unknown as AstNode

    const symbols: SymbolEntry[] = []
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

    const fileImports: FileImport[] = []
    const fileExports: FileExport[] = []
    const fileReExports: FileReExport[] = []
    const declarations: string[] = []

    if (Array.isArray(program.body)) {
      for (const statement of program.body) {
        if (!isAstNode(statement)) continue

        const localDeclNames: string[] = []
        if (
          statement.type === 'FunctionDeclaration' ||
          statement.type === 'ClassDeclaration' ||
          statement.type === 'TSInterfaceDeclaration' ||
          statement.type === 'TSTypeAliasDeclaration'
        ) {
          const name = extractName(statement)
          if (name) { declarations.push(name); localDeclNames.push(name) }
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

        if (statement.type === 'ImportDeclaration') {
          const imp = await parseImportDeclaration(statement, relPath, targetRoot, tsPaths, tsBaseUrl)
          if (imp) fileImports.push(imp)
        } else if (statement.type === 'ExportNamedDeclaration') {
          const { exports: exps, reExports } = await parseExportNamedDeclaration(
            statement, localDeclNames, relPath, targetRoot, tsPaths, tsBaseUrl,
          )
          fileExports.push(...exps)
          fileReExports.push(...reExports)
        } else if (statement.type === 'ExportAllDeclaration') {
          const srcNode = statement['source'] as { value: string } | undefined
          if (srcNode && typeof srcNode.value === 'string') {
            const resolved = await resolveModulePath(srcNode.value, relPath, targetRoot, tsPaths, tsBaseUrl)
            fileReExports.push({ source: srcNode.value, resolved, specifiers: [] })
          }
        } else if (statement.type === 'ExportDefaultDeclaration') {
          const decl = statement['declaration']
          const localName = isAstNode(decl) ? (extractName(decl) ?? 'default') : 'default'
          fileExports.push({ name: 'default', local: localName })
        }
      }
    }

    return {
      symbols,
      metadata: { file: relPath, imports: fileImports, exports: fileExports, reExports: fileReExports, declarations },
    }
  } catch (err) {
    console.error(`[Scout] Failed to parse ${relPath}:`, err)
    return { symbols: [], metadata: defaultMeta }
  }
}
