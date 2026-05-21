// Refactored: 2026-05-21 — modern JS/TS
// Shared AST utilities used by parser and pipeline extraction.
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { isAstNode, isIdentifier } from './types.js'

import type { AstNode } from './types.js'

export const SKIP_KEYS: ReadonlySet<string> = new Set(['loc', 'start', 'end', 'type'])

/** Iterative pre-order AST walker. Returning `true` from `visit` stops traversal. */
export function walkAst(root: AstNode, visit: (node: AstNode) => boolean | void): void {
  const stack: AstNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (visit(node) === true) return
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue
      const child = node[key]
      if (Array.isArray(child)) {
        for (const item of child) if (isAstNode(item)) stack.push(item)
      } else if (isAstNode(child)) {
        stack.push(child)
      }
    }
  }
}

/** Converts a byte/char offset within `source` to a 1-based line number. */
export function getLineFromOffset(source: string, offset: number): number {
  let line = 1
  const upper = Math.min(offset, source.length)
  for (let i = 0; i < upper; i++) {
    if (source.charCodeAt(i) === 10) line++
  }
  return line
}

/** Extracts the declared identifier name for a node (function / class / method). */
export function extractName(node: AstNode): string | null {
  const id = node['id']
  if (isIdentifier(id)) return id.name
  const key = node['key']
  if (isIdentifier(key)) return key.name
  return null
}

/** Returns the body start offset for declarations that have a block body. */
export function getBodyStartOffset(node: AstNode): number | null {
  const body = node['body']
  if (isAstNode(body) && typeof body.start === 'number') return body.start

  const value = node['value']
  if (isAstNode(value)) {
    const valueBody = value['body']
    if (isAstNode(valueBody) && typeof valueBody.start === 'number') return valueBody.start
  }

  const init = node['init']
  if (isAstNode(init)) {
    const initBody = init['body']
    if (isAstNode(initBody) && typeof initBody.start === 'number') return initBody.start
  }

  return null
}

interface ImportDeclarationLike extends AstNode {
  source: { value: string }
}

function isImportWithStringSource(node: AstNode): node is ImportDeclarationLike {
  if (node.type !== 'ImportDeclaration') return false
  const source = node['source']
  return (
    typeof source === 'object' &&
    source !== null &&
    typeof (source as { value?: unknown }).value === 'string'
  )
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath)
    return true
  } catch {
    return false
  }
}

/** Resolves all import specifiers (relative paths converted to .ts/.tsx where applicable). */
export async function extractFileImports(
  program: unknown,
  currentFileRelPath: string,
): Promise<string[]> {
  if (!isAstNode(program)) return []
  const body = program['body']
  if (!Array.isArray(body)) return []

  const cwd = process.cwd()
  const dir = path.dirname(currentFileRelPath)
  const seen = new Set<string>()
  const tasks: Array<Promise<string>> = []

  for (const node of body) {
    if (!isAstNode(node) || !isImportWithStringSource(node)) continue
    const raw = node.source.value

    if (!raw.startsWith('.')) {
      seen.add(raw)
      continue
    }

    const joined = path.join(dir, raw)
    if (!joined.endsWith('.js') && !joined.endsWith('.jsx')) {
      seen.add(joined)
      continue
    }

    const base = joined.replace(/\.jsx?$/, '')
    tasks.push(
      (async () => {
        if (await fileExists(path.join(cwd, `${base}.ts`))) return `${base}.ts`
        if (await fileExists(path.join(cwd, `${base}.tsx`))) return `${base}.tsx`
        return joined
      })(),
    )
  }

  for (const resolved of await Promise.all(tasks)) seen.add(resolved)
  return [...seen]
}
