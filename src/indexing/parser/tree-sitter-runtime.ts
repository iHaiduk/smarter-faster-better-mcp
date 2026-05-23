import { createRequire } from 'node:module'
import type { Node as SyntaxNode } from 'web-tree-sitter'

const require = createRequire(import.meta.url)
type WebTreeSitterModule = typeof import('web-tree-sitter')

let treeSitterInitialized = false
let treeSitterModule: WebTreeSitterModule | null = null

async function loadTreeSitterModule(): Promise<WebTreeSitterModule> {
  if (!treeSitterModule) {
    treeSitterModule = await import('web-tree-sitter')
  }
  return treeSitterModule
}

async function initTreeSitter() {
  if (treeSitterInitialized) return
  const { Parser } = await loadTreeSitterModule()
  const treeSitterWasmPath = require.resolve('web-tree-sitter/web-tree-sitter.wasm')
  await Parser.init({
    locateFile() {
      return treeSitterWasmPath
    },
  })
  treeSitterInitialized = true
}

const langCache = new Map<string, import('web-tree-sitter').Language>()

export async function getTreeSitterLanguage(
  ext: string,
  isTsx = false,
): Promise<import('web-tree-sitter').Language | null> {
  await initTreeSitter()
  const { Language } = await loadTreeSitterModule()

  const cacheKey = `${ext}::${isTsx}`
  if (langCache.has(cacheKey)) {
    return langCache.get(cacheKey) ?? null
  }

  let wasmPkg: string | null = null
  switch (ext) {
    case '.py': wasmPkg = '@repomix/tree-sitter-wasms/out/tree-sitter-python.wasm'; break
    case '.go': wasmPkg = '@repomix/tree-sitter-wasms/out/tree-sitter-go.wasm'; break
    case '.dart': wasmPkg = '@repomix/tree-sitter-wasms/out/tree-sitter-dart.wasm'; break
    case '.rs': wasmPkg = '@repomix/tree-sitter-wasms/out/tree-sitter-rust.wasm'; break
    case '.rb': wasmPkg = '@repomix/tree-sitter-wasms/out/tree-sitter-ruby.wasm'; break
    case '.java': wasmPkg = '@repomix/tree-sitter-wasms/out/tree-sitter-java.wasm'; break
    case '.cpp':
    case '.cc':
    case '.cxx':
    case '.h':
    case '.hpp':
      wasmPkg = '@repomix/tree-sitter-wasms/out/tree-sitter-cpp.wasm'; break
    case '.c': wasmPkg = '@repomix/tree-sitter-wasms/out/tree-sitter-c.wasm'; break
    case '.cs': wasmPkg = '@repomix/tree-sitter-wasms/out/tree-sitter-c_sharp.wasm'; break
    case '.php': wasmPkg = '@repomix/tree-sitter-wasms/out/tree-sitter-php.wasm'; break
    case '.js':
    case '.jsx':
      wasmPkg = '@repomix/tree-sitter-wasms/out/tree-sitter-javascript.wasm'; break
    case '.ts':
    case '.tsx':
      wasmPkg = isTsx || ext === '.tsx'
        ? '@repomix/tree-sitter-wasms/out/tree-sitter-tsx.wasm'
        : '@repomix/tree-sitter-wasms/out/tree-sitter-typescript.wasm'
      break
  }

  if (!wasmPkg) return null

  try {
    const wasmPath = require.resolve(wasmPkg)
    const lang = await Language.load(wasmPath)
    langCache.set(cacheKey, lang)
    return lang
  } catch (err) {
    console.error(`[Scout] Failed to load Tree-sitter language wasm for ${ext}:`, err)
    return null
  }
}

export async function createTreeSitterParser(
  lang: import('web-tree-sitter').Language,
): Promise<import('web-tree-sitter').Parser> {
  const { Parser } = await loadTreeSitterModule()
  const parser = new Parser()
  parser.setLanguage(lang)
  return parser
}

/**
 * Walks a tree-sitter node's children to find the identifier node that carries
 * the symbol name. Returns null when no name node can be located.
 */
export function findTreeSitterNameNode(node: SyntaxNode): SyntaxNode | null {
  const directName = node.childForFieldName('name')
  if (directName) return directName

  const queue: SyntaxNode[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (child) queue.push(child)
  }

  while (queue.length > 0) {
    const current = queue.shift()!
    if (isTreeSitterIdentifier(current.type)) return current

    const named = current.childForFieldName('name')
    if (named) return named

    if (
      current.type.includes('body') ||
      current.type.includes('block') ||
      current.type.includes('compound')
    ) {
      continue
    }

    for (let i = 0; i < current.childCount; i++) {
      const child = current.child(i)
      if (child) queue.push(child)
    }
  }

  return null
}

function isTreeSitterIdentifier(type: string): boolean {
  return type === 'identifier' || type === 'type_identifier' || type === 'field_identifier'
}
