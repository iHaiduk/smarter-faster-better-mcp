const MAX_GIT_HINT_FILES = 10

/** Comma-separated list of recently-changed .ts files (best-effort, never throws). */
export async function getGitHint(targetRoot = process.cwd()): Promise<string> {
  try {
    const proc = Bun.spawn(['git', 'diff', '--name-only', 'HEAD~3'], {
      stdout: 'pipe',
      stderr: 'ignore',
      cwd: targetRoot,
    })
    const out = await new Response(proc.stdout).text()
    return out
      .trim()
      .split('\n')
      .filter((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
      .slice(0, MAX_GIT_HINT_FILES)
      .join(', ')
  } catch {
    return ''
  }
}

/** Map of `relativePath -> "M"|"A"|"D"|"??"` from `git status --porcelain`. */
export async function getGitStatusMap(targetRoot = process.cwd()): Promise<Map<string, string>> {
  try {
    const proc = Bun.spawn(['git', 'status', '--porcelain'], {
      stdout: 'pipe',
      stderr: 'ignore',
      cwd: targetRoot,
    })
    const out = await new Response(proc.stdout).text()
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
