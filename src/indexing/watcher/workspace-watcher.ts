import * as path from 'node:path'
import chokidar from 'chokidar'

import { shouldIgnorePath } from '../../shared/constants/ignore-rules.js'
import { isTestFile } from '../../shared/constants/test-suffixes.js'
import { getParserMode, getSourceExtensions } from '../../config/index.js'
import { buildMap } from '../symbol-map/build-map.js'
import { applyIncrementalChanges, type IncrementalFileChange } from '../symbol-map/incremental-update.js'
import type { ProjectMap } from '../../shared/types/index.js'

const BATCH_OVERFLOW_THRESHOLD = 35
const DEBOUNCE_MS = 200

export type MapUpdateListener = (newMap: ProjectMap) => void

export class WorkspaceWatcher {
  private watcher: ReturnType<typeof chokidar.watch> | null = null
  private pendingChanges = new Map<string, 'add' | 'change' | 'unlink'>()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private currentMap: ProjectMap | null = null
  private isProcessing = false
  private listeners: Set<MapUpdateListener> = new Set()

  constructor(
    private readonly targetRoot: string = process.cwd(),
    initialMap?: ProjectMap,
  ) {
    if (initialMap) {
      this.currentMap = initialMap
    }
  }

  public setMap(map: ProjectMap): void {
    this.currentMap = map
  }

  public getMap(): ProjectMap | null {
    return this.currentMap
  }

  public onMapUpdate(listener: MapUpdateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notifyListeners(map: ProjectMap): void {
    for (const listener of this.listeners) {
      try {
        listener(map)
      } catch (err) {
        console.error('[Scout Watcher] Listener error:', err)
      }
    }
  }

  public start(): void {
    if (this.watcher) return

    const parserMode = getParserMode()
    const supportedExts = getSourceExtensions(parserMode)

    const shouldIgnore = (filePath: string): boolean => {
      const rel = path.isAbsolute(filePath)
        ? path.relative(this.targetRoot, filePath)
        : filePath
      if (!rel || rel === '.') return false
      return shouldIgnorePath(rel)
    }

    this.watcher = chokidar.watch(this.targetRoot, {
      ignored: shouldIgnore,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 150,
        pollInterval: 50,
      },
    })

    const handleEvent = (type: 'add' | 'change' | 'unlink', fullPath: string) => {
      const rel = path.relative(this.targetRoot, fullPath).replace(/\\/g, '/')
      const ext = path.extname(rel).toLowerCase()

      if (shouldIgnore(rel) || isTestFile(rel) || !supportedExts.has(ext)) {
        return
      }

      this.pendingChanges.set(rel, type)
      this.scheduleFlush()
    }

    this.watcher.on('add', (p: string) => handleEvent('add', p))
    this.watcher.on('change', (p: string) => handleEvent('change', p))
    this.watcher.on('unlink', (p: string) => handleEvent('unlink', p))

    console.error(`[Scout Watcher] Background file watcher started for ${this.targetRoot}`)
  }

  private scheduleFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      void this.flush()
    }, DEBOUNCE_MS)
  }

  public async flush(): Promise<void> {
    if (this.isProcessing || this.pendingChanges.size === 0) return
    this.isProcessing = true

    const changesMap = new Map(this.pendingChanges)
    this.pendingChanges.clear()

    const changeList: IncrementalFileChange[] = Array.from(changesMap.entries()).map(
      ([filePath, type]) => ({ path: filePath, type }),
    )

    try {
      if (changeList.length > BATCH_OVERFLOW_THRESHOLD || !this.currentMap) {
        console.error(
          `[Scout Watcher] Batch change count (${changeList.length}) exceeded threshold (${BATCH_OVERFLOW_THRESHOLD}) or map absent. Performing full rebuild...`,
        )
        this.currentMap = await buildMap(this.targetRoot)
      } else {
        console.error(
          `[Scout Watcher] Processing ${changeList.length} incremental file changes...`,
        )
        this.currentMap = await applyIncrementalChanges(
          this.currentMap,
          changeList,
          this.targetRoot,
        )
      }
      this.notifyListeners(this.currentMap)
    } catch (err) {
      console.error('[Scout Watcher] Failed to process file changes:', err)
    } finally {
      this.isProcessing = false
      if (this.pendingChanges.size > 0) {
        this.scheduleFlush()
      }
    }
  }

  public async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
      console.error('[Scout Watcher] Watcher stopped.')
    }
  }
}
