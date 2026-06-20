/** Builds the OpenAI-compatible chat completions endpoint URL. */
export function buildEndpoint(baseUrl: string): URL {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return new URL('chat/completions', normalized)
}
