// Refactored: 2026-05-21 — modern JS/TS
import { describe, expect, test } from 'bun:test'

import { extractName, getLineFromOffset, walkAst } from '../shared/utils/ast.js'

import type { AstNode } from '../shared/types/index.js'

function n(type: string, extras: Record<string, unknown> = {}): AstNode {
  return { type, start: 0, end: 0, ...extras }
}

describe('getLineFromOffset', () => {
  test('returns 1-based line number', () => {
    const src = 'a\nb\nc'
    expect(getLineFromOffset(src, 0)).toBe(1)
    expect(getLineFromOffset(src, 2)).toBe(2)
    expect(getLineFromOffset(src, 4)).toBe(3)
  })

  test('clamps offsets beyond source length', () => {
    expect(getLineFromOffset('abc', 999)).toBe(1)
  })
})

describe('extractName', () => {
  test('reads node.id.name for declarations', () => {
    expect(
      extractName(n('FunctionDeclaration', { id: { type: 'Identifier', name: 'foo', start: 0, end: 0 } })),
    ).toBe('foo')
  })

  test('reads node.key.name for method definitions', () => {
    expect(
      extractName(n('MethodDefinition', { key: { type: 'Identifier', name: 'bar', start: 0, end: 0 } })),
    ).toBe('bar')
  })

  test('returns null when nothing matches', () => {
    expect(extractName(n('FunctionDeclaration'))).toBeNull()
  })
})

describe('walkAst', () => {
  test('visits nested nodes', () => {
    const tree = n('Program', {
      body: [
        n('FunctionDeclaration', { id: { type: 'Identifier', name: 'a', start: 0, end: 0 } }),
        n('VariableDeclaration', {
          declarations: [n('VariableDeclarator', { id: { type: 'Identifier', name: 'b', start: 0, end: 0 } })],
        }),
      ],
    })

    const types: string[] = []
    walkAst(tree, (node) => {
      types.push(node.type)
    })

    expect(types).toContain('Program')
    expect(types).toContain('FunctionDeclaration')
    expect(types).toContain('VariableDeclaration')
    expect(types).toContain('VariableDeclarator')
  })

  test('stops traversal when visitor returns true (children of match are skipped)', () => {
    const tree = n('Root', {
      body: [n('Match', { body: [n('ChildA'), n('ChildB')] })],
    })

    const types: string[] = []
    walkAst(tree, (node) => {
      types.push(node.type)
      return node.type === 'Match'
    })

    expect(types).toContain('Match')
    expect(types).not.toContain('ChildA')
    expect(types).not.toContain('ChildB')
  })
})
