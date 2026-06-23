import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

import { clearL1 } from '../../cache/l1.js'
import { getMapFilePath, getParserMode, getSourceExtensions, MAX_SYMBOLS, PARSE_CHUNK_SIZE } from '../../config/index.js'
import { shouldIgnorePath, IGNORED_DIRS } from '../../shared/constants/ignore-rules.js'
import { isTestFile } from '../../shared/constants/test-suffixes.js'
import { loadTsConfigPaths } from '../resolver/tsconfig-paths.js'
import { parseFile } from '../parser/oxc-walker.js'
import type { FileMetadata, ParserMode, ProjectMap, SymbolEntry } from '../../shared/types/index.js'

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
  const dirsToScan: string[] = [dir]
  while (dirsToScan.length > 0) {
    const currentDir = dirsToScan.pop()!
    let entries: Dirent[]
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const fullPath = path.join(currentDir, entry.name)
      const relPath = path.relative(baseDir, fullPath)
      if (shouldSkipFile(relPath)) continue
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.includes(entry.name as typeof IGNORED_DIRS[number])) {
          continue
        }
        dirsToScan.push(fullPath)
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (supportedExtensions.has(ext)) {
          files.push(relPath)
        }
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
  const supportedExtensions = getSourceExtensions(parserMode)

  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: targetRoot, maxBuffer: 1024 * 1024 * 10 })
    const gitFiles = stdout.split('\n')
    for (const file of gitFiles) {
      if (!file) continue
      const ext = path.extname(file).toLowerCase()
      if (supportedExtensions.has(ext) && !shouldSkipFile(file)) {
        files.push(file)
      }
    }
    
    if (files.length > 0) {
      return files
    }
  } catch (err) {
    // Silently fall through if git is not available or not a git repo
  }

  try {
    await scanDirRecursive(targetRoot, targetRoot, files, supportedExtensions)
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
