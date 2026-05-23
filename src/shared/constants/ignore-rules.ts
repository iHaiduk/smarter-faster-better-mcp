/** Directories that are always excluded from scanning and searching. */
export const IGNORED_DIRS = [
  'node_modules', '.git', '.scout-cache', 'dist', 'build', 'coverage',
] as const

/** Path prefixes (for `IGNORED_DIRS` as relative-path substrings). */
export const IGNORED_PATH_PATTERNS = IGNORED_DIRS.map((d) => `${d}/`)

/** Returns true when a relative file path should be excluded from indexing. */
export function shouldIgnorePath(rel: string): boolean {
  return IGNORED_DIRS.some((dir) => rel.startsWith(`${dir}/`) || rel === dir)
}

/** Returns the `-not -path` fragment list suitable for the `find` command. */
export function ignoreFindArgs(): string[] {
  return IGNORED_DIRS.flatMap((d) => ['-not', '-path', `*/${d}/*`])
}
