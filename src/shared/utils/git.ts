import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { getParserMode, getSourceExtensions } from '../../config/index.js'
import { runCommand } from './node.js'

const MAX_GIT_HINT_FILES = 10

/** Comma-separated list of recently-changed files (best-effort, never throws). */
export async function getGitHint(targetRoot = process.cwd()): Promise<string> {
  try {
    const supportedExtensions = getSourceExtensions(getParserMode())
    const out = await runCommand(['git', 'diff', '--name-only', 'HEAD~3'], targetRoot)
    return out
      .trim()
      .split('\n')
      .filter((file) => {
        const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
        return supportedExtensions.has(ext)
      })
      .slice(0, MAX_GIT_HINT_FILES)
      .join(', ')
  } catch {
    return ''
  }
}

/** Map of `relativePath -> "M"|"A"|"D"|"??"` from `git status --porcelain`. */
export async function getGitStatusMap(targetRoot = process.cwd()): Promise<Map<string, string>> {
  try {
    const out = await runCommand(['git', 'status', '--porcelain'], targetRoot)
    const statusMap = new Map<string, string>()
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      const status = line.slice(0, 2).trim()
      const file = line.slice(3).trim()
      statusMap.set(file, status)
    }
    return statusMap
  } catch {
    return new Map()
  }
}

/** Worktree status type for a single file. */
export interface FileWorktreeStatus {
  readonly file: string
  readonly gitStatus: 'tracked' | 'staged' | 'modified' | 'untracked' | 'deleted'
  readonly indexFresh: boolean
  readonly source: 'index' | 'live-filesystem'
}

/**
 * Gets detailed worktree status for a list of files.
 * Shows whether each file is tracked, modified, staged, or untracked,
 * and whether the index data is fresh or stale.
 */
export async function getFileWorktreeStatuses(
  files: readonly string[],
  targetRoot = process.cwd(),
  mapGeneratedAt?: number,
): Promise<readonly FileWorktreeStatus[]> {
  const statusMap = await getGitStatusMap(targetRoot)
  const results: FileWorktreeStatus[] = []

  for (const file of files) {
    const gitStatus = statusMap.get(file) ?? ''

    let status: FileWorktreeStatus['gitStatus']
    if (gitStatus === '??') {
      status = 'untracked'
    } else if (gitStatus === 'M' || gitStatus === 'MM') {
      status = 'modified'
    } else if (gitStatus === 'A') {
      status = 'staged'
    } else if (gitStatus === 'D') {
      status = 'deleted'
    } else {
      status = 'tracked'
    }

    let indexFresh = true
    let source: FileWorktreeStatus['source'] = 'index'

    if (mapGeneratedAt && status !== 'untracked') {
      try {
        const stat = await fs.stat(path.join(targetRoot, file))
        if (stat.mtimeMs > mapGeneratedAt) {
          indexFresh = false
          source = 'live-filesystem'
        }
      } catch {
        // File might not exist or be inaccessible
      }
    } else if (status === 'untracked') {
      indexFresh = false
      source = 'live-filesystem'
    }

    results.push({ file, gitStatus: status, indexFresh, source })
  }

  return results
}
