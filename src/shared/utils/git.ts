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
