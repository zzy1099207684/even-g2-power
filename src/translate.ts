// Translates sealed segments, one request per segment, strictly in order.
// Clause-sized segments are sealed faster than translations come back, so
// requests queue up and run one at a time: an in-flight request is never
// aborted (that would silently lose that segment's translation), and
// onCommit fires in speech order, which transcript.ts's FIFO pairing relies
// on. The relay is a dumb forwarder: each request carries the model to use
// (endpoint URL, model name, API key — any OpenAI-compatible
// /chat/completions provider), polled fresh per request so a mid-session
// model switch applies from the next segment on.

import type { ModelProfile } from './config'

export interface TranslationSession {
  /** Call once per sealed segment. Queued; translated strictly in order. */
  submitFinal(text: string): void
  dispose(): void
}

// A hung request must not stall the queue forever — the watchdog aborts it,
// the error is surfaced, and the next segment gets its turn.
const REQUEST_TIMEOUT_MS = 10_000
// The phone's path to the relay is occasionally flaky (observed on device:
// only the last queued segment ever translated). One retry keeps a transient
// failure from silently losing a committed sentence forever.
const MAX_ATTEMPTS = 2
const RETRY_DELAY_MS = 800
// Translations trail speech; when the model is persistently slower, the queue
// would grow without bound and every translation would land minutes late —
// long after its lines scrolled off the glasses. Past this many queued
// segments, the oldest still-queued one is sacrificed (see submitFinal), so
// the newest speech keeps translating near-live. One lost old translation
// beats the whole lane lagging behind the conversation.
const MAX_PENDING = 8

// One queued segment. `dropped` marks a backlog-overflow victim: pump hands
// it back untranslated instead of translating it.
interface QueuedSegment {
  text: string
  dropped?: boolean
}

export function createTranslationSession(
  relayUrl: string,
  /** Translation target, as a natural-language name the model understands. */
  targetLang: string,
  /** Fires per segment, in speech order, when its translation is done. */
  onCommit: (text: string) => void,
  onError?: (err: unknown) => void,
  /** Prior conversation text for the model to reference (never translate);
   *  polled fresh on every request so the window slides as segments seal. */
  getContext?: () => string,
  /** The model to use, polled fresh on every request so a mid-session switch
   *  applies from the next request on. */
  getModel?: () => ModelProfile | null,
): TranslationSession {
  const queue: QueuedSegment[] = []
  let pumping = false
  let disposed = false
  let current: AbortController | null = null

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (queue.length > 0 && !disposed) {
        const entry = queue.shift()!
        if (entry.dropped) {
          // Backlog overflow victim: hand the original back untranslated. It
          // fires HERE, in queue order — dropping it with an immediate
          // onCommit at submit time could overtake an older in-flight
          // request and mispair transcript.ts's FIFO lanes.
          onCommit(entry.text)
          continue
        }
        await runTranslate(entry.text)
      }
    } finally {
      pumping = false
    }
  }

  async function runTranslate(text: string) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (await attemptTranslate(text)) return
      if (disposed || attempt >= MAX_ATTEMPTS) break
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
    }
    // Every attempt failed: pass the original through as its own translation.
    // transcript.ts pairs originals and translations FIFO — a segment that
    // commits nothing would shift every later pairing by one.
    if (!disposed) onCommit(text)
  }

  /** Runs one request for the segment; true when it completed (or is hopeless). */
  async function attemptTranslate(text: string): Promise<boolean> {
    const model = getModel?.()
    if (!model || !model.url || !model.name || !model.key) {
      onError?.(new Error('No model configured — add one in Settings'))
      return true
    }

    const abort = new AbortController()
    current = abort
    let timedOut = false
    const watchdog = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, REQUEST_TIMEOUT_MS)

    try {
      const res = await fetch(`${relayUrl}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, targetLang, context: getContext?.(), model }),
        signal: abort.signal,
      })
      if (!res.ok || !res.body) throw new Error(`translate request failed: ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let full = ''

      readLoop: for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice('data:'.length).trim()
          if (payload === '[DONE]') break readLoop
          const chunk = JSON.parse(payload)
          full += chunk.choices?.[0]?.delta?.content ?? ''
        }
      }

      onCommit(full)
      return true
    } catch (err) {
      if (timedOut) onError?.(new Error('translate request timed out'))
      else if (!disposed && (err as Error)?.name !== 'AbortError') onError?.(err)
      return false
    } finally {
      clearTimeout(watchdog)
      if (current === abort) current = null
    }
  }

  return {
    submitFinal(text) {
      if (!text) return
      // Over budget: sacrifice the oldest still-queued segment — mark it so
      // pump passes it through untranslated when its turn comes. Marking
      // keeps commit order intact (see pump); the newest speech keeps
      // translating near-live instead of the whole lane drifting behind.
      if (queue.length >= MAX_PENDING) {
        const victim = queue.find(entry => !entry.dropped)
        if (victim) victim.dropped = true
      }
      queue.push({ text })
      pump()
    },
    dispose() {
      disposed = true
      queue.length = 0
      current?.abort()
    },
  }
}
