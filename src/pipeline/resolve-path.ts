import * as path from 'node:path'
import * as fs from 'node:fs/promises'

import { fileExists } from '../shared/utils/node.js'

/** Validates that `fileRelPath` resolves strictly inside `targetRoot` and returns the real path. */
export async function resolveSecurePath(
  fileRelPath: string,
  targetRoot: string,
): Promise<{ realPath: string } | { error: string }> {
  const rootRealPath = await fs.realpath(targetRoot).catch(() => path.resolve(targetRoot))
  const absPath = path.resolve(rootRealPath, fileRelPath)

  const preRealpathRel = path.relative(rootRealPath, absPath)
  if (preRealpathRel.startsWith('..') || path.isAbsolute(preRealpathRel)) {
    return { error: `[Scout] Access denied: file is outside of the workspace root: ${fileRelPath}` }
  }

  if (!(await fileExists(absPath))) {
    return { error: `[Scout] File not found: ${fileRelPath}` }
  }

  const fileRealPath = await fs.realpath(absPath)
  const postRealpathRel = path.relative(rootRealPath, fileRealPath)
  if (postRealpathRel.startsWith('..') || path.isAbsolute(postRealpathRel)) {
    return { error: `[Scout] Access denied: file resolves outside of the workspace root: ${fileRelPath}` }
  }

  return { realPath: fileRealPath }
}
