// Translate up to three sealed segments at once. Only the oldest unfinished
// segment may stream to the display; completed results still commit in
// speech order, including same-language passthrough and error fallbacks.

import type { ModelProfile } from './config'

export interface TranslationSession {
  /** Passthrough skips the model but keeps the sentence in display order. */
  submitFinal(text: string, passthrough?: boolean): void
  dispose(): void
}

const MAX_CONCURRENT = 3
const MAX_PENDING = 8
// Idle deadlines: a healthy stream can take longer overall, but a stalled
// request cannot occupy a slot and block ordered output indefinitely.
const FIRST_TOKEN_TIMEOUT_MS = 15_000
const CHUNK_TIMEOUT_MS = 5_000
const MAX_ATTEMPTS = 2
const RETRY_DELAY_MS = 800
const RATE_LIMIT_ATTEMPTS = 4
const RATE_LIMIT_BACKOFF_MS = 1_000

interface QueuedSegment {
  text: string
  context: string | undefined
  passthrough: boolean
  state: 'queued' | 'running' | 'done'
  draft: string
  result: string
  failedAttempts: number
  rateLimitAttempts: number
  retryAt: number
}

type AttemptResult = { status: 'done'; text: string } | { status: 'failed' | 'rate-limited' }

export function createTranslationSession(
  relayUrl: string,
  targetLang: string,
  onCommit: (text: string, passthrough: boolean) => void,
  onError?: (err: unknown) => void,
  /** Snapshot preceding originals on submission, before later speech arrives. */
  getContext?: () => string,
  /** Read per request so a model switch applies to the next request. */
  getModel?: () => ModelProfile | null,
  /** Replace the current translation draft; never append it to the archive. */
  onPartial?: (text: string) => void,
): TranslationSession {
  const queue: QueuedSegment[] = []
  const controllers = new Set<AbortController>()
  let active = 0
  let concurrency = MAX_CONCURRENT
  let disposed = false
  let lastPreview = ''
  let wakeTimer: ReturnType<typeof setTimeout> | null = null
  let rateLimitHoldUntil = 0

  function publish() {
    if (disposed) return
    while (queue[0]?.state === 'done') {
      const entry = queue.shift()!
      // Committing replaces the displayed draft atomically. The next
      // sentence may have identical text and must still get its own draft.
      onCommit(entry.result, entry.passthrough)
      lastPreview = ''
    }
    const draft = queue[0]?.draft ?? ''
    if (draft !== lastPreview) {
      lastPreview = draft
      onPartial?.(draft)
    }
  }

  function pump() {
    if (disposed) return
    if (wakeTimer !== null) {
      clearTimeout(wakeTimer)
      wakeTimer = null
    }
    publish()
    const now = Date.now()
    let nextWake = Infinity
    for (const entry of queue) {
      if (active >= concurrency) break
      if (entry.state !== 'queued') continue
      const readyAt = Math.max(entry.retryAt, rateLimitHoldUntil)
      if (readyAt > now) {
        nextWake = Math.min(nextWake, readyAt)
        continue
      }
      entry.state = 'running'
      active++
      void run(entry)
    }
    if (nextWake !== Infinity) wakeTimer = setTimeout(pump, nextWake - now)
  }

  async function run(entry: QueuedSegment) {
    const result = await attemptTranslate(entry)
    active--
    if (disposed) return
    entry.draft = ''
    if (result.status === 'done') {
      entry.result = result.text
      entry.state = 'done'
    } else if (result.status === 'rate-limited') {
      // Multiple in-flight requests can receive 429. All retries and new sentences
      // share one gate, then continue one at a time for this session.
      concurrency = 1
      entry.rateLimitAttempts++
      const delay = RATE_LIMIT_BACKOFF_MS * 2 ** Math.min(entry.rateLimitAttempts - 1, 2)
      rateLimitHoldUntil = Math.max(rateLimitHoldUntil, Date.now() + delay)
      entry.state = entry.rateLimitAttempts >= RATE_LIMIT_ATTEMPTS ? 'done' : 'queued'
    } else {
      entry.failedAttempts++
      entry.state = entry.failedAttempts >= MAX_ATTEMPTS ? 'done' : 'queued'
      entry.retryAt = Date.now() + RETRY_DELAY_MS
    }
    // result starts as the original, preserving FIFO pairing if all
    // attempts fail. Clearing a failed draft never archives a half sentence.
    pump()
  }

  async function attemptTranslate(entry: QueuedSegment): Promise<AttemptResult> {
    const model = getModel?.()
    if (!model || !model.url || !model.name || !model.key) {
      onError?.(new Error('No model configured — add one in Settings'))
      return { status: 'done', text: entry.text }
    }

    const abort = new AbortController()
    controllers.add(abort)
    let timedOut = false
    let streamedAny = false
    let watchdog: ReturnType<typeof setTimeout> | null = null
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
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
        body: JSON.stringify({ text: entry.text, targetLang, context: entry.context, model }),
        signal: abort.signal,
      })
      armIdleWatchdog()
      if (!res.ok || !res.body) {
        void res.body?.cancel().catch(() => {})
        if (res.status === 429) {
          if (!disposed) onError?.(new Error('translate request failed: 429'))
          return { status: 'rate-limited' }
        }
        throw new Error(`translate request failed: ${res.status}`)
      }

      reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let full = ''
      let finished = false

      while (!finished) {
        const { done, value } = await reader.read()
        if (disposed) return { status: 'failed' }
        if (done) break
        streamedAny = streamedAny || value.length > 0
        armIdleWatchdog()
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice('data:'.length).trim()
          if (payload === '[DONE]') {
            finished = true
            break
          }
          const chunk = JSON.parse(payload)
          full += chunk.choices?.[0]?.delta?.content ?? ''
        }
        entry.draft = full
        publish()
      }
      return { status: 'done', text: full || entry.text }
    } catch (err) {
      if (!disposed) {
        if (timedOut) onError?.(new Error(streamedAny ? 'translate stream stalled mid-way' : 'translate request timed out'))
        else if ((err as Error)?.name !== 'AbortError') onError?.(err)
      }
      return { status: 'failed' }
    } finally {
      if (watchdog !== null) clearTimeout(watchdog)
      if (reader) {
        void reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      controllers.delete(abort)
    }
  }

  return {
    submitFinal(text, passthrough = false) {
      if (!text || disposed) return
      if (!passthrough && queue.filter(entry => entry.state === 'queued').length >= MAX_PENDING) {
        const victim = queue.find(entry => entry.state === 'queued')!
        victim.state = 'done'
      }
      queue.push({
        text, context: getContext?.(), passthrough,
        state: passthrough ? 'done' : 'queued', draft: '', result: text,
        failedAttempts: 0, rateLimitAttempts: 0, retryAt: 0,
      })
      pump()
    },
    dispose() {
      disposed = true
      if (wakeTimer !== null) clearTimeout(wakeTimer)
      queue.length = 0
      for (const controller of controllers) controller.abort()
      controllers.clear()
    },
  }
}
