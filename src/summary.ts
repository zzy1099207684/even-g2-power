import type { ModelProfile } from './config'

// One request per completed session, independent of the live translation queue.
export async function generateSummary(
  text: string,
  targetLang: string,
  relayUrl: string,
  model: ModelProfile,
  signal?: AbortSignal,
): Promise<string> {
  const abort = new AbortController()
  const cancel = () => abort.abort()
  if (signal?.aborted) cancel()
  signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, 90_000)
  try {
    const response = await fetch(`${relayUrl.replace(/\/+$/, '')}/summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, targetLang, model }),
      signal: abort.signal,
    })
    if (!response.ok) throw new Error(`summary request failed: ${response.status}`)
    const data = await response.json() as {
      choices?: { message?: { content?: string }; finish_reason?: string }[]
    }
    const choice = data.choices?.[0]
    const summary = choice?.message?.content
    if (typeof summary !== 'string' || !summary.trim() || choice?.finish_reason === 'length') {
      throw new Error('summary is empty or incomplete')
    }
    return summary.trim()
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', cancel)
  }
}
