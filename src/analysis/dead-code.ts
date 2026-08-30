import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import type { DeadCodeItem, DeadCodeReport, ProjectMap, SymbolEntry } from '../shared/types/index.js'
import { fileExists } from '../shared/utils/node.js'
import { matchGlob, normalizePath } from '../shared/utils/glob.js'

export interface DeadCodeOptions {
  readonly entrypoints?: readonly string[]
  readonly includeExports?: boolean
  readonly includeFiles?: boolean
  readonly includeSymbols?: boolean
  readonly minConfidence?: number
}

const COMMON_ROOT_CONFIG_PATTERNS = [
  '*.config.*',
  'tsconfig*.json',
  '.eslintrc*',
  'eslint.config.*',
  'vite.config.*',
  'next.config.*',
  'webpack.config.*',
  'rollup.config.*',
  'tsup.config.*',
  'babel.config.*',
  'jest.config.*',
]

/**
 * Discovers project entrypoints from package.json and well-known configuration files.
 */
export async function discoverEntrypoints(
  targetRoot: string,
  map: ProjectMap,
  customEntrypoints: readonly string[] = [],
): Promise<string[]> {
  const entrypoints = new Set<string>()

  // 1. Add user-provided custom entrypoints
  for (const ep of customEntrypoints) {
    entrypoints.add(normalizePath(ep))
  }

  // 2. Inspect package.json
  try {
    const pkgJsonPath = path.join(targetRoot, 'package.json')
    if (await fileExists(pkgJsonPath)) {
      const content = await fs.readFile(pkgJsonPath, 'utf8')
      const pkg = JSON.parse(content)

      if (typeof pkg.main === 'string') entrypoints.add(normalizePath(pkg.main))
      if (typeof pkg.module === 'string') entrypoints.add(normalizePath(pkg.module))

      if (typeof pkg.bin === 'string') {
        entrypoints.add(normalizePath(pkg.bin))
      } else if (typeof pkg.bin === 'object' && pkg.bin !== null) {
        for (const binPath of Object.values(pkg.bin)) {
          if (typeof binPath === 'string') entrypoints.add(normalizePath(binPath))
        }
      }

      if (typeof pkg.exports === 'string') {
        entrypoints.add(normalizePath(pkg.exports))
      } else if (typeof pkg.exports === 'object' && pkg.exports !== null) {
        const collectExports = (obj: Record<string, unknown>) => {
          for (const val of Object.values(obj)) {
            if (typeof val === 'string') entrypoints.add(normalizePath(val))
            else if (typeof val === 'object' && val !== null) collectExports(val as Record<string, unknown>)
          }
        }
        collectExports(pkg.exports)
      }
    }
  } catch {
    // Ignore package.json parsing issues
  }

  // 3. Fallback standard index/main/cli files from project map
  const allFiles = (map.files ?? []).map((f) => f.file)
  for (const f of allFiles) {
    const norm = normalizePath(f)
    const base = path.basename(norm)
    const withoutExt = base.replace(/\.[^.]+$/, '')

    if (
      withoutExt === 'index' ||
      withoutExt === 'main' ||
      withoutExt === 'cli' ||
      norm.startsWith('src/bin/') ||
      norm.startsWith('bin/')
    ) {
      entrypoints.add(norm)
    }

    // Config files
    for (const pattern of COMMON_ROOT_CONFIG_PATTERNS) {
      if (matchGlob(norm, pattern) || matchGlob(base, pattern)) {
        entrypoints.add(norm)
      }
    }
  }

  return Array.from(entrypoints)
}

/**
 * Traverses the file dependency graph from root entrypoints using BFS to find all reachable files.
 */
export function findReachableFiles(
  entrypoints: readonly string[],
  map: ProjectMap,
): { reachableFiles: Set<string>; deadFiles: string[] } {
  const reachableFiles = new Set<string>()
  const queue: string[] = []

  const fileMetaMap = new Map<string, NonNullable<ProjectMap['files']>[number]>()
  if (map.files) {
    for (const f of map.files) {
      fileMetaMap.set(f.file, f)
      fileMetaMap.set(normalizePath(f.file), f)
    }
  }

  // Match entrypoints against actual files in map
  for (const ep of entrypoints) {
    const normEp = normalizePath(ep)
    for (const f of fileMetaMap.keys()) {
      if (
        f === ep ||
        f === normEp ||
        f.endsWith(normEp) ||
        normEp.endsWith(f) ||
        f.replace(/\.[^.]+$/, '') === normEp.replace(/\.[^.]+$/, '')
      ) {
        if (!reachableFiles.has(f)) {
          reachableFiles.add(f)
          queue.push(f)
        }
      }
    }
  }

  // BFS Reachability Traversal
  while (queue.length > 0) {
    const current = queue.shift()!
    const meta = fileMetaMap.get(current)
    if (!meta) continue

    for (const imp of meta.imports) {
      if (imp.resolved && !reachableFiles.has(imp.resolved)) {
        reachableFiles.add(imp.resolved)
        queue.push(imp.resolved)
      }
    }

    for (const reExp of meta.reExports) {
      if (reExp.resolved && !reachableFiles.has(reExp.resolved)) {
        reachableFiles.add(reExp.resolved)
        queue.push(reExp.resolved)
      }
    }
  }

  const deadFiles: string[] = []
  if (map.files) {
    for (const f of map.files) {
      if (!reachableFiles.has(f.file)) {
        deadFiles.push(f.file)
      }
    }
  }

  return { reachableFiles, deadFiles }
}

/**
 * Finds exported symbols that are never imported anywhere in the reachable project files.
 */
export function findDeadExports(
  reachableFiles: Set<string>,
  map: ProjectMap,
  entrypoints: readonly string[] = [],
): DeadCodeItem[] {
  if (!map.files) return []

  // 1. Build map of all imported specifiers across the project
  // targetFile -> Set of imported specifier names (or '*' for wildcard)
  const importedSpecifiersByFile = new Map<string, Set<string>>()
  const wildcardReExportedFiles = new Set<string>()

  for (const f of map.files) {
    for (const imp of f.imports) {
      if (!imp.resolved) continue
      const set = importedSpecifiersByFile.get(imp.resolved) ?? new Set<string>()
      for (const spec of imp.specifiers) {
        set.add(spec.imported)
      }
      importedSpecifiersByFile.set(imp.resolved, set)
    }

    for (const reExp of f.reExports) {
      if (!reExp.resolved) continue
      if (reExp.specifiers.length === 0) {
        wildcardReExportedFiles.add(reExp.resolved)
      } else {
        const set = importedSpecifiersByFile.get(reExp.resolved) ?? new Set<string>()
        for (const spec of reExp.specifiers) {
          set.add(spec.imported)
        }
        importedSpecifiersByFile.set(reExp.resolved, set)
      }
    }
  }

  const deadExports: DeadCodeItem[] = []

  // Map symbols for line numbers
  const symbolKeyToLine = new Map<string, SymbolEntry>()
  for (const sym of map.symbols) {
    symbolKeyToLine.set(`${sym.file}::${sym.name}`, sym)
  }

  // Collect normalized entrypoint files
  const entrypointFileSet = new Set(Array.from(entrypoints).map((ep) => normalizePath(ep)))

  for (const f of map.files) {
    const normFile = normalizePath(f.file)
    // If file is not reachable, its whole file is already dead
    if (!reachableFiles.has(f.file) && !reachableFiles.has(normFile)) continue
    // If file is a root entrypoint or wildcard re-exported (public API boundary), its exports are public and alive
    if (entrypointFileSet.has(normFile) || entrypointFileSet.has(f.file)) continue
    if (wildcardReExportedFiles.has(f.file) || wildcardReExportedFiles.has(normFile)) continue

    const usedSpecifiers = importedSpecifiersByFile.get(f.file) ?? importedSpecifiersByFile.get(normFile) ?? new Set<string>()
    if (usedSpecifiers.has('*')) continue // Namespace import used

    for (const exp of f.exports) {
      // Ignore default exports of entrypoints or tests
      if (exp.name === 'default' && (f.file.includes('index') || f.file.includes('cli') || f.file.includes('test'))) continue

      if (!usedSpecifiers.has(exp.name)) {
        const sym = symbolKeyToLine.get(`${f.file}::${exp.local}`)
        deadExports.push({
          type: 'dead_export',
          file: f.file,
          name: exp.name,
          line: sym?.line,
          kind: sym?.kind,
          confidence: 0.95,
          reason: `Exported as "${exp.name}" but never imported by any module in the workspace.`,
        })
      }
    }
  }

  return deadExports
}

/**
 * Executes full dead code analysis across the codebase.
 */
export async function analyzeDeadCode(
  targetRoot: string,
  map: ProjectMap,
  options: DeadCodeOptions = {},
): Promise<DeadCodeReport> {
  const minConfidence = options.minConfidence ?? 0.7
  const entrypoints = await discoverEntrypoints(targetRoot, map, options.entrypoints)
  const { reachableFiles, deadFiles } = findReachableFiles(entrypoints, map)

  const deadFileItems: DeadCodeItem[] = deadFiles.map((file) => ({
    type: 'dead_file',
    file,
    name: path.basename(file),
    confidence: 1.0,
    reason: 'Unreachable from project entrypoints and has 0 incoming imports.',
  }))

  const deadExports = options.includeExports !== false ? findDeadExports(reachableFiles, map, entrypoints) : []

  const filteredDeadFiles = deadFileItems.filter((i) => i.confidence >= minConfidence)
  const filteredDeadExports = deadExports.filter((i) => i.confidence >= minConfidence)

  return {
    summary: {
      totalFilesScanned: map.files?.length ?? 0,
      deadFilesCount: filteredDeadFiles.length,
      deadExportsCount: filteredDeadExports.length,
      deadSymbolsCount: 0,
      entrypointsCount: entrypoints.length,
    },
    entrypoints,
    deadFiles: filteredDeadFiles,
    deadExports: filteredDeadExports,
    deadSymbols: [],
  }
}
