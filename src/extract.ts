// Refactored: 2026-05-21 — modern JS/TS
// AST-driven extraction of concrete symbol bodies + associated type definitions.

import * as path from 'node:path'

import { parseSync } from 'oxc-parser'

import { extractFileImports, extractName, getBodyStartOffset, getLineFromOffset, walkAst } from './ast.js'
import { isIdentifier } from './types.js'

import type { AstNode, ExtractedSymbol, LLMCandidate, ProjectMap } from './types.js'

const MAX_TYPE_DEFS = 3
const FALLBACK_LINES = 20

/** Pulls up to `MAX_TYPE_DEFS` interface/type-alias definitions referenced inside `code`. */
export async function extractTypeDefinitions(
  code: string,
  map: ProjectMap,
  excludeSymbol: string,
): Promise<string[]> {
  const codeWords = new Set(code.split(/[\s\W_]+/))
  const defs: string[] = []

  for (const sym of map.symbols) {
    if (defs.length >= MAX_TYPE_DEFS) break
    if (sym.name === excludeSymbol) continue
    if (sym.kind !== 'TSInterfaceDeclaration' && sym.kind !== 'TSTypeAliasDeclaration') continue
    if (!codeWords.has(sym.name)) continue

    try {
      const absPath = path.join(process.cwd(), sym.file)
      const fileObj = Bun.file(absPath)
      if (!(await fileObj.exists())) continue
      const source = await fileObj.text()
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

/** Extracts the full (or summarized) source of `candidate` plus its imports and associated types. */
export async function extractWithOxc(
  candidate: LLMCandidate,
  map: ProjectMap,
  summaryOnly = false,
): Promise<ExtractedSymbol> {
  const absPath = path.join(process.cwd(), candidate.file)
  const fileObj = Bun.file(absPath)
  const mapEntry = map.symbols.find(
    (sym) => sym.file === candidate.file && sym.name === candidate.symbol,
  )

  if (!(await fileObj.exists())) {
    console.error(`[Scout] File not found: ${candidate.file}`)
    return {
      candidate,
      code: `[File not found: ${candidate.file}]`,
      signature: '',
      doc: '',
      imports: [],
      importedBy: [],
      extractionOk: false,
    }
  }

  const source = await fileObj.text()
  let targetNode: AstNode | null = null
  let imports: string[] = []

  try {
    if (candidate.file.endsWith('.json')) {
      const parsedJson = JSON.parse(source)
      const foundValue = parsedJson[candidate.symbol]
      if (foundValue !== undefined) {
        return {
          candidate,
          code: `"${candidate.symbol}": ${JSON.stringify(foundValue, null, 2)}`,
          signature: mapEntry?.signature ?? '',
          doc: '',
          imports: [],
          importedBy: [],
          extractionOk: true,
          startLine: 1,
          endLine: 1,
          typeDefs: [],
          fullLength: JSON.stringify(foundValue).length
        }
      }
    } else {
      const parsed = parseSync(candidate.file, source)
      imports = await extractFileImports(parsed.program, candidate.file)
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
    const lines = source.split('\n')
    const startIdx = Math.max(0, lines.findIndex((l) => !l.startsWith('import') && l.trim() !== ''))
    const fallback = lines.slice(startIdx, startIdx + FALLBACK_LINES).join('\n')
    return {
      candidate,
      code: `[Exact extraction failed — showing file start]\n\n${fallback}`,
      signature: mapEntry?.signature ?? '',
      doc: mapEntry?.doc ?? '',
      imports,
      importedBy: [],
      extractionOk: false,
      startLine: startIdx + 1,
      endLine: Math.min(lines.length, startIdx + FALLBACK_LINES),
    }
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

  const typeDefs = await extractTypeDefinitions(code, map, candidate.symbol)

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
