import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { loadConfig, getParserMode } from '../config/index.js'
import { buildMap, getProjectFiles } from '../indexing/symbol-map/build-map.js'
import type { ProjectMap } from '../shared/types/index.js'

describe('Integration: Config Loading', () => {
  const savedEnv = {
    SCOUT_BASE_URL: process.env['SCOUT_BASE_URL'],
    SCOUT_API_KEY: process.env['SCOUT_API_KEY'],
    SCOUT_MODEL: process.env['SCOUT_MODEL'],
  }

  beforeAll(() => {
    process.env['SCOUT_BASE_URL'] = process.env['SCOUT_BASE_URL'] ?? 'http://localhost:11434/v1'
    process.env['SCOUT_API_KEY'] = process.env['SCOUT_API_KEY'] ?? 'test-key'
    process.env['SCOUT_MODEL'] = process.env['SCOUT_MODEL'] ?? 'test-model'
  })

  afterAll(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = val
      }
    }
  })

  test('loadConfig returns valid ScoutConfig', () => {
    const config = loadConfig()
    expect(config).toBeDefined()
    expect(typeof config.parser).toBe('string')
    expect(config.parser).toMatch(/^(oxc|tree-sitter)$/)
    expect(typeof config.llmTimeoutMs).toBe('number')
    expect(config.llmTimeoutMs).toBeGreaterThan(0)
    expect(typeof config.llmParallelism).toBe('number')
    expect(config.llmParallelism).toBeGreaterThan(0)
  })

  test('getParserMode returns valid mode', () => {
    const mode = getParserMode()
    expect(mode).toMatch(/^(oxc|tree-sitter)$/)
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
