/** Builds the OpenAI-compatible chat completions endpoint URL. */
export function buildEndpoint(baseUrl: string): URL {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return new URL('chat/completions', normalized)
}

interface LlmMessage {
  readonly role: 'system' | 'user'
  readonly content: string
}

interface LlmFetchOptions {
  readonly model: string
  readonly maxTokens: number
  readonly temperature?: number
  readonly timeoutMs?: number
}

interface LlmChatResponse {
  readonly choices: ReadonlyArray<{ readonly message?: { readonly content?: string } }>
}

/**
 * Shared LLM fetch helper. Returns the raw content string or null on failure.
 * When `signal` is provided, the caller manages timeout/cancellation.
 * When `signal` is absent, `options.timeoutMs` is used to create an internal controller.
 */
export async function llmFetch(
  baseUrl: string,
  apiKey: string,
  messages: readonly LlmMessage[],
  options: LlmFetchOptions,
  signal?: AbortSignal,
): Promise<string | null> {
  const controller = signal ? undefined : new AbortController()
  const timeout =
    !signal && options.timeoutMs
      ? setTimeout(() => controller!.abort(), options.timeoutMs)
      : undefined

  try {
    const res = await fetch(buildEndpoint(baseUrl), {
      method: 'POST',
      signal: signal ?? controller!.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        max_tokens: options.maxTokens,
        temperature: options.temperature ?? 0,
        messages,
      }),
    })

    if (!res.ok) {
      console.error(`[Scout] LLM HTTP ${res.status}`)
      return null
    }

    const data = (await res.json()) as LlmChatResponse
    const content = data.choices.at(0)?.message?.content ?? ''
    return content.trim() || null
  } catch (err) {
    if (!(err instanceof Error) || err.name !== 'AbortError') {
      console.error('[Scout] LLM request failed:', err instanceof Error ? err.message : String(err))
    }
    return null
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
