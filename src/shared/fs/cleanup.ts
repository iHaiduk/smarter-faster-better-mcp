import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'

/**
 * Cleans the workspace by removing ONLY the scout's own cache files and directories
 * (.scout-cache and .project_map.json), ensuring that user files/directories are never touched.
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

    // Only clean up .scout-cache directory if it exists
    const scoutCachePath = path.join(rootRealPath, '.scout-cache')
    const scoutCacheExists = await fs.stat(scoutCachePath).then(() => true).catch(() => false)
    if (scoutCacheExists) {
      deleted.push('.scout-cache')
      if (!dryRun) {
        await fs.rm(scoutCachePath, { recursive: true, force: true }).catch((err) => {
          console.error(`[Scout Cleanup] Failed to delete folder .scout-cache:`, err)
        })
      }
    }

    // Only clean up .project_map.json file if it exists
    const projectMapPath = path.join(rootRealPath, '.project_map.json')
    const projectMapExists = await fs.stat(projectMapPath).then(() => true).catch(() => false)
    if (projectMapExists) {
      deleted.push('.project_map.json')
      if (!dryRun) {
        await fs.unlink(projectMapPath).catch((err) => {
          console.error(`[Scout Cleanup] Failed to delete file .project_map.json:`, err)
        })
      }
    }
  } catch (err) {
    console.error(`[Scout Cleanup] Cleanup failed under ${workspaceRoot}:`, err)
  }

  return { deleted, preserved }
}
