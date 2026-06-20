import * as path from 'node:path'
import * as fs from 'node:fs/promises'

import { parseSync } from 'oxc-parser'
import type { Node as SyntaxNode } from 'web-tree-sitter'

import { extractName, getBodyStartOffset, getLineFromOffset, walkAst } from '../shared/utils/ast.js'
import { isIdentifier } from '../shared/types/index.js'
import { createTreeSitterParser, findTreeSitterNameNode, getTreeSitterLanguage } from '../indexing/parser/tree-sitter-runtime.js'
import { getParserMode } from '../config/index.js'
import { fileExists } from '../shared/utils/node.js'
import {
  extractFallback,
  extractJsonProperty,
  missingFileResult,
} from './fragment/extract-fallbacks.js'

import type { AstNode, ExtractedSymbol, LLMCandidate, ProjectMap } from '../shared/types/index.js'

const MAX_TYPE_DEFS = 3

const TS_DECLARATION_KEYWORDS = ['function', 'class', 'const', 'let', 'interface', 'type']
const NON_TS_DECLARATION_KEYWORDS = ['def ', 'fn ', 'func ', 'class ', 'struct ', 'interface ']

// Tree-sitter node types that may declare a named symbol.
const TREE_SITTER_WALKABLE_KINDS: ReadonlySet<string> = new Set([
  'function_definition',
  'function_declaration',
  'function_item',
  'function_signature',
  'function_signature_item',
  'class_definition',
  'class_declaration',
  'method_definition',
  'method_declaration',
  'struct_specifier',
  'struct_item',
  'interface_declaration',
  'trait_item',
  'type_declaration',
  'type_alias_declaration',
])

/** Pulls up to `MAX_TYPE_DEFS` interface/type-alias definitions referenced inside `code`. */
export async function extractTypeDefinitions(
  code: string,
  map: ProjectMap,
  excludeSymbol: string,
  targetRoot = process.cwd(),
): Promise<string[]> {
  const codeWords = new Set(code.split(/[\s\W_]+/))
  const defs: string[] = []

  for (const sym of map.symbols) {
    if (defs.length >= MAX_TYPE_DEFS) break
    if (sym.name === excludeSymbol) continue
    if (sym.kind !== 'TSInterfaceDeclaration' && sym.kind !== 'TSTypeAliasDeclaration') continue
    if (!codeWords.has(sym.name)) continue

    try {
      const absPath = path.join(targetRoot, sym.file)
      if (!(await fileExists(absPath))) continue
      const source = await fs.readFile(absPath, 'utf8')
      const parsed = parseSync(sym.file, source)
      const program = parsed.program as unknown as AstNode

      let target: AstNode | null = null
      walkAst(program, (node) => {
        if (
          (node.type === 'TSInterfaceDeclaration' || node.type === 'TSTypeAliasDeclaration') &&
          isIdentifier(node['id']) &&
          (node['id'] as { name: string }).name === sym.name
        ) {
          target = node
          return true
        }
        return false
      })

      if (target) {
        const node = target as AstNode
        const typeCode = source.substring(node.start, node.end)
        defs.push(
          `type:${sym.name} (${sym.file}:${getLineFromOffset(source, node.start)})\n${typeCode}`,
        )
      }
    } catch {
      // ignored: best-effort lookup
    }
  }
  return defs
}

/** Collapses the body of a Tree-sitter SyntaxNode for code summarization. */
function collapseTreeSitterBody(node: SyntaxNode, source: string): string {
  const bodyNode = node.childForFieldName('body')
  if (bodyNode) {
    const beforeBody = source.substring(node.startIndex, bodyNode.startIndex)
    if (beforeBody.trim().endsWith(':')) {
      return `${beforeBody.trimEnd()} ...`
    }
    return `${beforeBody.trimEnd()} { /* ... */ }`
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (
      child &&
      (child.type.includes('block') ||
        child.type.includes('compound') ||
        child.type.includes('body'))
    ) {
      const beforeBody = source.substring(node.startIndex, child.startIndex)
      if (beforeBody.trim().endsWith(':')) {
        return `${beforeBody.trimEnd()} ...`
      }
      return `${beforeBody.trimEnd()} { /* ... */ }`
    }
  }

  return node.text
}

/** Searches a tree-sitter subtree for a node declaring `symbolName`. Returns null if not found. */
function findSymbolNode(root: SyntaxNode, symbolName: string): SyntaxNode | null {
  if (TREE_SITTER_WALKABLE_KINDS.has(root.type)) {
    const nameNode = findTreeSitterNameNode(root)
    if (nameNode?.text === symbolName) return root
  }
  for (let i = 0; i < root.childCount; i++) {
    const child = root.child(i)
    if (child) {
      const found = findSymbolNode(child, symbolName)
      if (found) return found
    }
  }
  return null
}

/** Extracts the source of a symbol in a non-JS/TS file using web-tree-sitter. */
export async function extractWithTreeSitter(
  candidate: LLMCandidate,
  map: ProjectMap,
  summaryOnly = false,
  targetRoot = process.cwd(),
): Promise<ExtractedSymbol> {
  const absPath = path.join(targetRoot, candidate.file)
  const mapEntry = map.symbols.find(
    (sym) => sym.file === candidate.file && sym.name === candidate.symbol,
  )
  const imports = map.files
    ?.find((fileMeta) => fileMeta.file === candidate.file)
    ?.imports.map((imp) => imp.resolved ?? imp.source) ?? []

  if (!(await fileExists(absPath))) {
    console.error(`[Scout] File not found: ${candidate.file}`)
    return missingFileResult(candidate)
  }

  const source = await fs.readFile(absPath, 'utf8')
  const ext = path.extname(candidate.file).toLowerCase()

  if (candidate.file.endsWith('.json')) {
    const jsonResult = extractJsonProperty(candidate, source, mapEntry)
    if (jsonResult) return jsonResult
    console.error(`[Scout] Failed to parse JSON for extraction in ${candidate.file}`)
  }

  const isTsx = candidate.file.endsWith('.tsx')
  const lang = await getTreeSitterLanguage(ext, isTsx)
  let targetNode: SyntaxNode | null = null

  if (lang) {
    try {
      const parser = await createTreeSitterParser(lang)
      const tree = parser.parse(source)
      if (tree) {
        targetNode = findSymbolNode(tree.rootNode, candidate.symbol)
      }
    } catch (err) {
      console.error(`[Scout] Tree-sitter failed for extraction in ${candidate.file}:`, err)
    }
  }

  if (!targetNode) {
    return extractFallback(candidate, source, mapEntry, imports, NON_TS_DECLARATION_KEYWORDS)
  }

  const node = targetNode as unknown as SyntaxNode
  const startOffset = node.startIndex
  const endOffset = node.endIndex
  let code = source.substring(startOffset, endOffset)
  const fullLength = code.length

  if (summaryOnly) {
    code = collapseTreeSitterBody(node, source)
  }

  const typeDefs = await extractTypeDefinitions(code, map, candidate.symbol, targetRoot)

  return {
    candidate,
    code,
    signature: mapEntry?.signature ?? '',
    doc: mapEntry?.doc ?? '',
    imports,
    importedBy: [],
    extractionOk: true,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    typeDefs,
    fullLength,
  }
}

/** Extracts the full (or summarized) source of `candidate` plus its imports and associated types. */
export async function extractWithOxc(
  candidate: LLMCandidate,
  map: ProjectMap,
  summaryOnly = false,
  targetRoot = process.cwd(),
): Promise<ExtractedSymbol> {
  const parserMode = getParserMode()
  const ext = path.extname(candidate.file).toLowerCase()
  const isJsTs = ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx'

  if (!isJsTs) {
    if (parserMode !== 'tree-sitter') {
      return {
        candidate,
        code: `[Unsupported parser mode for ${candidate.file}: enable --parser tree-sitter to inspect non-JS/TS files]`,
        signature: '',
        doc: '',
        imports: [],
        importedBy: [],
        extractionOk: false,
      }
    }
    return extractWithTreeSitter(candidate, map, summaryOnly, targetRoot)
  }

  const absPath = path.join(targetRoot, candidate.file)
  const mapEntry = map.symbols.find(
    (sym) => sym.file === candidate.file && sym.name === candidate.symbol,
  )
  const imports = map.files
    ?.find((fileMeta) => fileMeta.file === candidate.file)
    ?.imports.map((imp) => imp.resolved ?? imp.source) ?? []

  if (!(await fileExists(absPath))) {
    console.error(`[Scout] File not found: ${candidate.file}`)
    return missingFileResult(candidate)
  }

  const source = await fs.readFile(absPath, 'utf8')
  let targetNode: AstNode | null = null

  try {
    if (candidate.file.endsWith('.json')) {
      const jsonResult = extractJsonProperty(candidate, source, mapEntry)
      if (jsonResult) return jsonResult
    } else {
      const parsed = parseSync(candidate.file, source)
      const program = parsed.program as unknown as AstNode

      walkAst(program, (node) => {
        if (extractName(node) === candidate.symbol) {
          targetNode = node
          return true
        }
        if (node.type === 'VariableDeclarator') {
          const id = node['id']
          if (isIdentifier(id) && id.name === candidate.symbol) {
            targetNode = node
            return true
          }
        }
        return false
      })
    }
  } catch (err) {
    console.error(`[Scout] Failed to parse AST for extraction in ${candidate.file}:`, err)
  }

  if (!targetNode) {
    return extractFallback(candidate, source, mapEntry, imports, TS_DECLARATION_KEYWORDS)
  }

  const node: AstNode = targetNode
  const startOffset = node.start
  const endOffset = node.end
  let code = source.substring(startOffset, endOffset)
  const fullLength = code.length

  if (summaryOnly) {
    const bodyStart = getBodyStartOffset(node)
    if (bodyStart !== null) {
      const beforeBody = source.substring(startOffset, bodyStart)
      code = `${beforeBody.trimEnd()} { /* ... */ }`
    }
  }

  const typeDefs = await extractTypeDefinitions(code, map, candidate.symbol, targetRoot)

  return {
    candidate,
    code,
    signature: mapEntry?.signature ?? '',
    doc: mapEntry?.doc ?? '',
    imports,
    importedBy: [],
    extractionOk: true,
    startLine: getLineFromOffset(source, startOffset),
    endLine: getLineFromOffset(source, endOffset),
    typeDefs,
    fullLength,
  }
}
