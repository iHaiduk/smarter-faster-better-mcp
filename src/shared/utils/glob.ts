const GLOB_SPECIAL = /[.+^${}()|[\]\\]/g
const GLOB_CACHE_MAX = 64

/** Normalizes path separators to forward slashes. */
export const normalizePath = (s: string): string => s.replace(/\\/g, '/')

/** Converts a glob pattern (with *, **, ?) into a RegExp. */
export function globToRegex(pattern: string): RegExp {
  const normalizedPattern = normalizePath(pattern)
  const cached = globCache.get(normalizedPattern)
  if (cached) return cached

  const parts: string[] = []
  let i = 0
  while (i < normalizedPattern.length) {
    const ch = normalizedPattern[i]!
    if (ch === '*' && normalizedPattern[i + 1] === '*') {
      parts.push('.*')
      i += 2
      if (i < normalizedPattern.length && normalizedPattern[i] === '/') i++
    } else if (ch === '*') {
      parts.push('[^/]*')
      i++
    } else if (ch === '?') {
      parts.push('[^/]')
      i++
    } else {
      parts.push(ch.replace(GLOB_SPECIAL, '\\$&'))
      i++
    }
  }
  const regex = new RegExp(`^${parts.join('')}$`, 'i')
  if (globCache.size >= GLOB_CACHE_MAX) globCache.clear()
  globCache.set(normalizedPattern, regex)
  return regex
}

const globCache = new Map<string, RegExp>()

/** Returns the basename of a forward-slash normalized path. */
export const getBasename = (normalizedPath: string): string => {
  const idx = normalizedPath.lastIndexOf('/')
  return idx === -1 ? normalizedPath : normalizedPath.slice(idx + 1)
}

/** Matches a path against a glob pattern, supporting basename matching when pattern has no slashes. */
export function matchGlob(filePath: string, pattern: string): boolean {
  const normalizedPath = normalizePath(filePath)
  const normalizedPattern = normalizePath(pattern)
  const regex = globToRegex(normalizedPattern)
  if (regex.test(normalizedPath)) return true
  if (!normalizedPattern.includes('/')) {
    const base = getBasename(normalizedPath)
    if (regex.test(base)) return true
  }
  return false
}
