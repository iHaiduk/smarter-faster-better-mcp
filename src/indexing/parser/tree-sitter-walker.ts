import type { Node as SyntaxNode } from 'web-tree-sitter'
import { createTreeSitterParser, findTreeSitterNameNode, getTreeSitterLanguage } from './tree-sitter-runtime.js'
import type { FileMetadata, SymbolEntry, SymbolKind } from '../../shared/types/index.js'

const KIND_BY_NODE_TYPE: ReadonlyMap<string, SymbolKind> = new Map([
  ['function_definition', 'FunctionDeclaration'],
  ['function_declaration', 'FunctionDeclaration'],
  ['function_item', 'FunctionDeclaration'],
  ['function_signature', 'FunctionDeclaration'],
  ['function_signature_item', 'FunctionDeclaration'],
  ['class_definition', 'ClassDeclaration'],
  ['class_declaration', 'ClassDeclaration'],
  ['method_definition', 'MethodDefinition'],
  ['method_declaration', 'MethodDefinition'],
  ['struct_specifier', 'StructDeclaration'],
  ['struct_item', 'StructDeclaration'],
  ['interface_declaration', 'InterfaceDeclaration'],
  ['trait_item', 'InterfaceDeclaration'],
  ['type_declaration', 'TypeDeclaration'],
  ['type_alias_declaration', 'TypeDeclaration'],
])

/** Extracts an inline docstring or preceding comment for a tree-sitter node. */
function extractDocFromTreeSitterNode(node: SyntaxNode): string {
  if (node.type === 'function_definition' || node.type === 'class_definition') {
    const body = node.childForFieldName('body')
    if (body && body.childCount > 0) {
      const firstStmt = body.child(0)
      if (firstStmt?.type === 'expression_statement') {
        const strNode = firstStmt.child(0)
        if (strNode?.type === 'string') {
          return strNode.text.replace(/['"]+/g, '').trim().slice(0, 300)
        }
      }
    }
  }

  const prev = node.previousSibling
  if (prev?.type === 'comment') {
    return prev.text
      .replace(/^\s*#+\s*/, '')
      .replace(/^\s*\/\/*\s*/, '')
      .trim()
      .slice(0, 300)
  }

  return ''
}

/** Walks a tree-sitter subtree, collecting named symbol entries. */
function walkForSymbols(rootNode: SyntaxNode, relPath: string, out: SymbolEntry[]): void {
  const stack: SyntaxNode[] = [rootNode]
  while (stack.length > 0) {
    const node = stack.pop()!
    const kind = KIND_BY_NODE_TYPE.get(node.type)
    if (kind) {
      const nameNode = findTreeSitterNameNode(node)
      if (nameNode) {
        const fullText = node.text
        const signature = (fullText.split('\n')[0] ?? '').trim().replace(/\s+/g, ' ').slice(0, 200)
        out.push({
          name: nameNode.text,
          file: relPath,
          line: node.startPosition.row + 1,
          kind,
          signature,
          doc: extractDocFromTreeSitterNode(node),
        })
      }
    }

    for (let i = node.childCount - 1; i >= 0; i--) {
      const child = node.child(i)
      if (child) stack.push(child)
    }
  }
}

export async function parseFileWithTreeSitter(
  source: string,
  relPath: string,
  ext: string,
): Promise<{ symbols: SymbolEntry[]; metadata: FileMetadata }> {
  const defaultMeta: FileMetadata = {
    file: relPath,
    imports: [],
    exports: [],
    reExports: [],
    declarations: [],
  }

  try {
    const isTsx = relPath.endsWith('.tsx')
    const lang = await getTreeSitterLanguage(ext, isTsx)
    if (!lang) return { symbols: [], metadata: defaultMeta }

    const parser = await createTreeSitterParser(lang)
    const tree = parser.parse(source)
    if (!tree) return { symbols: [], metadata: defaultMeta }

    const symbols: SymbolEntry[] = []
    walkForSymbols(tree.rootNode, relPath, symbols)

    return {
      symbols,
      metadata: {
        file: relPath,
        imports: [],
        exports: [],
        reExports: [],
        declarations: symbols.map((s) => s.name),
      },
    }
  } catch (err) {
    console.error(`[Scout] Tree-sitter failed parsing ${relPath}:`, err)
    return { symbols: [], metadata: defaultMeta }
  }
}
