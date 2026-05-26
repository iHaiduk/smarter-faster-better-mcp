/** Directories that are always excluded from scanning and searching. */
export const IGNORED_DIRS = [
  // 1. Dependency Directories
  'node_modules',

  // 2. Build & Compilation Artifacts (Compiled/built files)
  'dist',
  'build',
  'bin',
  'out',

  // 3. Cache & History Directories
  'cache',
  '.scout-cache',
  '.cache',
  'history',
  '.history',

  // 4. Temporary Directories
  'tmp',
  'temp',
  '.ostmp',

  // 5. IDE & VCS Meta-Directories (Also caught by .* filter)
  '.git',
  '.ide',
  '.vscode',
  '.expo',
  '.next',
  '.nuxt',
  'coverage',
] as const

/** Critical files/configs that must not be ignored during standard processing/indexing. */
const CRITICAL_DOTFILES = new Set([
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
])

/** Path prefixes (for `IGNORED_DIRS` as relative-path substrings). */
export const IGNORED_PATH_PATTERNS = IGNORED_DIRS.map((d) => `${d}/`)

/** Returns true when a relative file path should be excluded from indexing. */
export function shouldIgnorePath(rel: string): boolean {
  // Check if any path component starts with a dot and is not critical
  const parts = rel.split(/[/\\]/)
  const hasUnwantedDotPart = parts.some(
    (part) => part.startsWith('.') && !CRITICAL_DOTFILES.has(part)
  )
  if (hasUnwantedDotPart) {
    return true
  }

  // Check if any of the IGNORED_DIRS matches exactly or as a parent directory
  return IGNORED_DIRS.some(
    (dir) =>
      rel === dir ||
      rel.startsWith(`${dir}/`) ||
      rel.startsWith(`${dir}\\`) ||
      parts.includes(dir)
  )
}

/** Returns the `-not -path` fragment list suitable for the `find` command. */
export function ignoreFindArgs(): string[] {
  return IGNORED_DIRS.flatMap((d) => ['-not', '-path', `*/${d}/*`])
}
