import * as path from 'node:path'
import * as fs from 'node:fs/promises'

import { clearL1 } from '../../cache.js'
import { getMapFilePath, getParserMode, getSourceExtensions, MAX_SYMBOLS, PARSE_CHUNK_SIZE } from '../../config.js'
import { shouldIgnorePath, IGNORED_DIRS } from '../../shared/constants/ignore-rules.js'
import { isTestFile } from '../../shared/constants/test-suffixes.js'
import { loadTsConfigPaths } from '../resolver/tsconfig-paths.js'
import { parseFile } from '../parser/oxc-walker.js'
import type { FileMetadata, ParserMode, ProjectMap, SymbolEntry } from '../../types.js'

const EXTRA_IGNORE_SUFFIXES = ['.d.ts', 'package-lock.json', '.project_map.json'] as const

function shouldSkipFile(file: string): boolean {
  return (
    shouldIgnorePath(file) ||
    isTestFile(file) ||
    EXTRA_IGNORE_SUFFIXES.some((suffix) => file.endsWith(suffix))
  )
}

async function scanDirRecursive(
  dir: string,
  baseDir: string,
  files: string[],
  supportedExtensions: ReadonlySet<string>,
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    const relPath = path.relative(baseDir, fullPath)
    if (shouldSkipFile(relPath)) continue

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.includes(entry.name as typeof IGNORED_DIRS[number])) {
        continue
      }
      await scanDirRecursive(fullPath, baseDir, files, supportedExtensions)
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (supportedExtensions.has(ext)) {
        files.push(relPath)
      }
    }
  }
}

/** Lists relative paths of source files under targetRoot, skipping noise. */
export async function getProjectFiles(
  targetRoot: string,
  parserMode: ParserMode = getParserMode(),
): Promise<string[]> {
  const files: string[] = []
  try {
    await scanDirRecursive(targetRoot, targetRoot, files, getSourceExtensions(parserMode))
  } catch (err) {
    console.error(`[Scout] getProjectFiles failed under ${targetRoot}:`, err)
  }
  return files
}

/** Builds and persists the project symbol map and import graph. */
export async function buildMap(targetRoot = process.cwd()): Promise<ProjectMap> {
  const parserMode = getParserMode()
  const files = await getProjectFiles(targetRoot, parserMode)
  console.error(`[Scout] Building map (${parserMode}) for ${files.length} files under ${targetRoot}...`)

  const tsconfig = await loadTsConfigPaths(targetRoot)
  const allSymbols: SymbolEntry[] = []
  const filesMetadata: FileMetadata[] = []

  for (let i = 0; i < files.length; i += PARSE_CHUNK_SIZE) {
    const chunk = files.slice(i, i + PARSE_CHUNK_SIZE)
    const results = await Promise.all(
      chunk.map((f) => parseFile(f, targetRoot, parserMode, tsconfig.paths, tsconfig.baseUrl)),
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
    parserMode,
    symbolsCount: Math.min(allSymbols.length, MAX_SYMBOLS),
    symbols: allSymbols.slice(0, MAX_SYMBOLS),
    files: filesMetadata,
  }

  clearL1()
  await fs.writeFile(getMapFilePath(targetRoot), JSON.stringify(map), 'utf8')
  console.error(`[Scout] Map built: ${map.symbolsCount} symbols`)
  return map
}
