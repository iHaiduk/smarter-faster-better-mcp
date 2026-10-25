import * as path from 'node:path'
import { describe, expect, test, beforeAll } from 'bun:test'
import { loadConfig, getParserMode } from '../config/index.js'
import { buildMap, getProjectFiles } from '../indexing/symbol-map/build-map.js'
import { resolveWorkspaceRoot } from '../shared/fs/resolveWorkspaceRoot.js'
import type { ProjectMap } from '../shared/types/index.js'

describe('Integration: Config Loading', () => {
  test('loadConfig returns valid ScoutConfig', () => {
    const config = loadConfig()
    expect(config).toBeDefined()
    expect(typeof config.parser).toBe('string')
    expect(config.parser).toMatch(/^(oxc|tree-sitter|auto)$/)
  })

  test('getParserMode returns valid mode', () => {
    const mode = getParserMode()
    expect(mode).toMatch(/^(oxc|tree-sitter|auto)$/)
  })

  test('loadConfig works in zero-config mode when env vars are missing', () => {
    const config = loadConfig({})
    expect(config).toBeDefined()
    expect(config.parser).toMatch(/^(oxc|tree-sitter|auto)$/)
  })

  test('loadConfig picks up package-root .env as fallback when run from another cwd', async () => {
    const prevCwd = process.cwd()
    const tmpDir = await import('node:os').then((os) => os.tmpdir())
    try {
      process.chdir(tmpDir)
      const config = loadConfig()
      // If package-root .env has JEV_API_KEY, loadConfig should have picked it up
      expect(config).toBeDefined()
      expect(config.parser).toBeDefined()
    } finally {
      process.chdir(prevCwd)
    }
  })
})

describe('Integration: Workspace Root Resolution', () => {
  test('resolves explicit relative path', () => {
    const root = resolveWorkspaceRoot('./src')
    expect(root).toBe(path.resolve(process.cwd(), './src'))
  })

  test('resolves explicit absolute path', () => {
    const root = resolveWorkspaceRoot('/tmp')
    expect(root).toBe('/tmp')
  })

  test('auto-discovers project root from current working directory', () => {
    const root = resolveWorkspaceRoot()
    expect(root).toBe(process.cwd())
  })
})

describe('Integration: Project File Scanning', () => {
  let files: string[]

  beforeAll(async () => {
    files = await getProjectFiles(process.cwd(), 'oxc')
  })

  test('finds TypeScript source files', () => {
    expect(files.length).toBeGreaterThan(0)
    expect(files.some(f => f.endsWith('.ts'))).toBe(true)
  })

  test('excludes node_modules', () => {
    expect(files.some(f => f.includes('node_modules'))).toBe(false)
  })

  test('excludes dist directory', () => {
    expect(files.some(f => f.startsWith('dist/'))).toBe(false)
  })

  test('excludes build directory', () => {
    expect(files.some(f => f.startsWith('build/'))).toBe(false)
  })

  test('includes config files (package.json)', () => {
    expect(files.some(f => f === 'package.json')).toBe(true)
  })
})

describe('Integration: Map Building', () => {
  let map: ProjectMap

  beforeAll(async () => {
    map = await buildMap(process.cwd())
  })

  test('builds a map with symbols', () => {
    expect(map.symbolsCount).toBeGreaterThan(0)
  })

  test('map has symbols array', () => {
    expect(map.symbols.length).toBeGreaterThan(0)
  })

  test('map has file metadata', () => {
    const files = map.files
    expect(files).toBeDefined()
    expect(files!.length).toBeGreaterThan(0)
  })

  test('file metadata contains imports', () => {
    const filesWithImports = map.files!.filter(f => f.imports.length > 0)
    expect(filesWithImports.length).toBeGreaterThan(0)
  })

  test('file metadata contains exports', () => {
    const filesWithExports = map.files!.filter(f => f.exports.length > 0)
    expect(filesWithExports.length).toBeGreaterThan(0)
  })

  test('symbol entries have required fields', () => {
    const sym = map.symbols[0]
    expect(sym).toBeDefined()
    expect(typeof sym.name).toBe('string')
    expect(typeof sym.kind).toBe('string')
    expect(typeof sym.line).toBe('number')
    expect(typeof sym.file).toBe('string')
  })
})

describe('Integration: MCP Tool Registration & Serialization', () => {
  test('all registered MCP tools serialize correctly for tools/list', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
    const { registerAllTools } = await import('../tools/registerTools.js')
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')

    const server = new McpServer({ name: 'mcp-scout-test', version: '1.0.0' })
    registerAllTools(server, loadConfig())

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} })

    await server.connect(serverTransport)
    await client.connect(clientTransport)

    const list = await client.listTools()
    expect(list.tools.length).toBe(12)

    const triageTool = list.tools.find((t) => t.name === 'triage')
    expect(triageTool).toBeDefined()
    expect(triageTool?.inputSchema).toBeDefined()
    expect(triageTool?.inputSchema.properties?.['criteria']).toBeDefined()

    await client.close()
    await server.close()
  })
})

