import * as path from 'node:path'

export function resolveWorkspaceRoot(workspaceRoot?: string): string {
  if (!workspaceRoot) return process.cwd()
  return path.resolve(process.cwd(), workspaceRoot)
}
