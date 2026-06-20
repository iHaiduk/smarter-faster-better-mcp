/** Strips markdown fences / surrounding text to isolate a JSON payload (objects or arrays). */
export function cleanJSON(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1]) return fenced[1].trim()

  const startObj = raw.indexOf('{')
  const startArr = raw.indexOf('[')

  const start =
    startObj !== -1 && startArr !== -1
      ? Math.min(startObj, startArr)
      : startObj !== -1 ? startObj : startArr

  const end = start === startObj ? raw.lastIndexOf('}') : raw.lastIndexOf(']')

  if (start !== -1 && end !== -1 && end > start) {
    return raw.slice(start, end + 1)
  }

  return raw.trim()
}
