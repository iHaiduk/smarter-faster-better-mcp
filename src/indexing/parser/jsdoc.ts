/** Extracts the JSDoc block immediately preceding a symbol's start offset. */
export function extractJSDoc(source: string, symbolStart: number): string {
  const before = source.slice(0, symbolStart)
  const match = before.match(/\/\*\*([\s\S]*?)\*\/\s*$/)
  if (!match?.[1]) return ''
  return match[1]
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 300)
}

/** Returns the one-line signature of a code block (up to 200 chars). */
export function buildSignature(text: string): string {
  const bodyStart = text.indexOf('{')
  const head = bodyStart > 0 ? text.slice(0, bodyStart) : text.split('\n')[0] ?? ''
  return head.trim().replace(/\s+/g, ' ').slice(0, 200)
}
