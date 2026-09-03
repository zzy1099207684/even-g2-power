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
// the error is surfaced, and the next segment gets its turn. The watchdog is
// an IDLE limit, not a total deadline: response headers and every streamed
// chunk re-arm it, so a slow-but-alive stream finishes instead of being
// killed mid-flight at an arbitrary wall-clock limit. Two phases: upstream
// may legitimately think for a while before its first token, but once tokens
// are flowing, a silence that long means the connection died.
const FIRST_TOKEN_TIMEOUT_MS = 15_000
const CHUNK_TIMEOUT_MS = 5_000
// The phone's path to the relay is occasionally flaky (observed on device:
// only the last queued segment ever translated). One retry keeps a transient
// failure from silently losing a committed sentence forever.
const MAX_ATTEMPTS = 2
const RETRY_DELAY_MS = 800
// A 429 means the provider's per-minute budget is briefly spent — the 800 ms
// retry above just burns attempt two against a still-closed window (observed
// on device: choppy speech sealed three fragments within seconds and every
// request 429'd, so the fallback filled the translation lane with originals).
// Rate-limited segments get their own short ladder (1s → 2s → 4s, then the
// original-passthrough fallback in runTranslate): a translation minutes late
// is worthless on live captions, so backing off longer than this would stall
// the whole queue for text nobody is reading anymore.
const RATE_LIMIT_ATTEMPTS = 4 // first try + 3 ladder retries
const RATE_LIMIT_BACKOFF_MS = 1_000 // doubling per ladder step
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

  // One closure-wide gate: after ANY 429, the next request — this segment's
  // ladder retry or the next queued segment's first try — waits here first.
  // Choppy speech fires a request every few seconds; without this gap a fresh
  // segment keeps re-tripping the same per-minute window.
  let rateLimitHoldUntil = 0

  async function runTranslate(text: string) {
    let failedAttempts = 0
    let rateLimitAttempts = 0
    for (;;) {
      if (disposed) return
      if (Date.now() < rateLimitHoldUntil)
        await new Promise(resolve => setTimeout(resolve, rateLimitHoldUntil - Date.now()))
      if (disposed) return
      const result = await attemptTranslate(text)
      if (result === 'done') return
      if (result === 'rate-limited') {
        rateLimitAttempts++
        if (rateLimitAttempts >= RATE_LIMIT_ATTEMPTS) break
        rateLimitHoldUntil = Date.now() + RATE_LIMIT_BACKOFF_MS * 2 ** (rateLimitAttempts - 1)
        continue
      }
      failedAttempts++
      if (disposed || failedAttempts >= MAX_ATTEMPTS) break
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
    }
    // Every attempt failed: pass the original through as its own translation.
    // transcript.ts pairs originals and translations FIFO — a segment that
    // commits nothing would shift every later pairing by one.
    if (!disposed) onCommit(text)
  }

  /**
   * Runs one request for the segment. 'done': committed (or hopeless — no
   * retry). 'rate-limited': 429, worth a delayed retry. 'failed': transient
   * error, worth the fast retry.
   */
  async function attemptTranslate(text: string): Promise<'done' | 'failed' | 'rate-limited'> {
    const model = getModel?.()
    if (!model || !model.url || !model.name || !model.key) {
      onError?.(new Error('No model configured — add one in Settings'))
      return 'done'
    }

    const abort = new AbortController()
    current = abort
    let timedOut = false
    let streamedAny = false
    let watchdog: ReturnType<typeof setTimeout> | null = null
    // Re-armed by every sign of progress; the phase decides how much silence
    // is tolerated (see the constants above).
    const armIdleWatchdog = () => {
      if (watchdog !== null) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        timedOut = true
        abort.abort()
      }, streamedAny ? CHUNK_TIMEOUT_MS : FIRST_TOKEN_TIMEOUT_MS)
    }
    armIdleWatchdog()

    try {
      const res = await fetch(`${relayUrl}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, targetLang, context: getContext?.(), model }),
        signal: abort.signal,
      })
      armIdleWatchdog() // response headers arrived — the request is alive
      if (!res.ok || !res.body) {
        if (res.status === 429) {
          onError?.(new Error('translate request failed: 429'))
          return 'rate-limited'
        }
        throw new Error(`translate request failed: ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let full = ''

      readLoop: for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        streamedAny = streamedAny || value.length > 0
        armIdleWatchdog() // a chunk just arrived — the stream is alive
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
      return 'done'
    } catch (err) {
      if (timedOut)
        onError?.(
          new Error(streamedAny ? 'translate stream stalled mid-way' : 'translate request timed out'),
        )
      else if (!disposed && (err as Error)?.name !== 'AbortError') onError?.(err)
      return 'failed'
    } finally {
      if (watchdog !== null) clearTimeout(watchdog)
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
