import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'

/** Essential folders/files that must never be removed during cleanup. */
const CRITICAL_FOLDERS = new Set([
  'src',
  'node_modules',
  'bower_components',
  '.github',
  '.copilot',
  '.cursor',
  '.gemini',
  '.git',
])

const CRITICAL_FILES = new Set([
  '.env',
  '.env.example',
  '.env.local',
  '.env.development',
  '.env.test',
  '.env.production',
  '.gitignore',
  '.npmignore',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  '.eslint.config.js',
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.json',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  'package.json',
  'tsconfig.json',
  'bun.lock',
  'yarn.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
])

/** Directories to clean up at the root of the workspace. */
const ROOT_CLEANUP_DIRS = new Set([
  'dist',
  'build',
  'cache',
  'bin',
  'coverage',
  '.scout-cache',
  '.ide',
  '.vscode',
  '.expo',
  '.next',
  '.nuxt',
  'out',
  '.ostmp',
  'tmp',
  'temp',
])

/** Files to recursively clean up anywhere they appear (except inside critical folders). */
const RECURSIVE_CLEANUP_FILES = new Set([
  '.DS_Store',
  '.AppleDouble',
  '.LSOverride',
  'Thumbs.db',
])

/**
 * Traverses the workspace root and cleans up build folders, temporary directories,
 * and unwanted dot files/folders while keeping implementation-critical code and node_modules.
 */
export async function cleanupWorkspace(
  workspaceRoot: string,
  options: { dryRun?: boolean } = {}
): Promise<{ deleted: string[]; preserved: string[] }> {
  const deleted: string[] = []
  const preserved: string[] = []
  const dryRun = options.dryRun ?? false

  try {
    const rootRealPath = await fs.realpath(workspaceRoot)
    const systemHome = os.homedir()
    if (rootRealPath === systemHome || path.dirname(rootRealPath) === rootRealPath) {
      console.error(`[Scout Cleanup] Cleanup skipped: ${rootRealPath} is the filesystem root or user home directory.`)
      return { deleted, preserved }
    }
    const entries = await fs.readdir(rootRealPath, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(rootRealPath, entry.name)
      const relPath = entry.name

      if (entry.isDirectory()) {
        // If it is in our critical list or node_modules, preserve it!
        if (CRITICAL_FOLDERS.has(relPath) || relPath === 'node_modules') {
          preserved.push(relPath)
          continue
        }

        // If it starts with a dot and is not in critical folders, OR is a designated cleanup folder
        const isTargetDotDir = relPath.startsWith('.')
        const isRootCleanupDir = ROOT_CLEANUP_DIRS.has(relPath)

        if (isTargetDotDir || isRootCleanupDir) {
          deleted.push(relPath)
          if (!dryRun) {
            await fs.rm(fullPath, { recursive: true, force: true }).catch((err) => {
              console.error(`[Scout Cleanup] Failed to delete folder ${relPath}:`, err)
            })
          }
        } else {
          // It's some other non-critical directory (e.g. custom directories). Preserve it.
          preserved.push(relPath)
          // Run recursive system file cleanup inside non-critical, non-ignored folders
          await cleanRecursiveSystemFiles(fullPath, rootRealPath, deleted, dryRun)
        }
      } else if (entry.isFile()) {
        // Handle files at the root level
        const isCriticalFile = CRITICAL_FILES.has(relPath)
        const isSystemFile = RECURSIVE_CLEANUP_FILES.has(relPath)
        const isUnwantedDotFile = relPath.startsWith('.') && !isCriticalFile

        if (isSystemFile || isUnwantedDotFile) {
          deleted.push(relPath)
          if (!dryRun) {
            await fs.unlink(fullPath).catch((err) => {
              console.error(`[Scout Cleanup] Failed to delete file ${relPath}:`, err)
            })
          }
        } else {
          preserved.push(relPath)
        }
      }
    }
  } catch (err) {
    console.error(`[Scout Cleanup] Cleanup failed under ${workspaceRoot}:`, err)
  }

  return { deleted, preserved }
}

/** Recursively removes designated system junk files like .DS_Store from directories. */
async function cleanRecursiveSystemFiles(
  dir: string,
  rootPath: string,
  deletedList: string[],
  dryRun: boolean
): Promise<void> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const relPath = path.relative(rootPath, fullPath)

      // Guard: do not traverse into critical folders if any are nested
      if (entry.isDirectory()) {
        if (CRITICAL_FOLDERS.has(entry.name) || entry.name === 'node_modules') {
          continue
        }
        await cleanRecursiveSystemFiles(fullPath, rootPath, deletedList, dryRun)
      } else if (entry.isFile()) {
        if (RECURSIVE_CLEANUP_FILES.has(entry.name)) {
          deletedList.push(relPath)
          if (!dryRun) {
            await fs.unlink(fullPath).catch((err) => {
              console.error(`[Scout Cleanup] Failed to recursively delete file ${relPath}:`, err)
            })
          }
        }
      }
    }
  } catch {
    // Silently ignore access errors for individual nested subfolders
  }
}
