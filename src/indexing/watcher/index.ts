import { WorkspaceWatcher } from './workspace-watcher.js'
import { getDiagnosticsService } from '../../tools/diagnosticsTool.js'
import type { ProjectMap } from '../../shared/types/index.js'

let activeWatcher: WorkspaceWatcher | null = null

export function getWorkspaceWatcher(targetRoot = process.cwd(), initialMap?: ProjectMap): WorkspaceWatcher {
  if (!activeWatcher) {
    activeWatcher = new WorkspaceWatcher(targetRoot, initialMap)
    
    // Wire up LSP Diagnostics syncing with watcher events
    activeWatcher.onMapUpdate((map) => {
      const diagService = getDiagnosticsService(targetRoot)
      if (map.files) {
        for (const fileMeta of map.files) {
          void diagService.syncFile(fileMeta.file)
        }
      }
    })
  }
  return activeWatcher
}

export async function stopWorkspaceWatcher(): Promise<void> {
  if (activeWatcher) {
    await activeWatcher.stop()
    activeWatcher = null
  }
}
