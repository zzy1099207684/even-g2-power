// Calls the relay's /translate endpoint (DeepSeek deepseek-v4-flash, thinking
// disabled) and renders a live-updating translation as the source utterance
// is still being spoken.
//
// Retranslating the whole growing sentence on every partial risks the
// already-displayed text changing wording as more context arrives — jarring
// on a glasses display. This uses the "Local Agreement" policy real-time
// translation products use for exactly this problem: after each retranslate,
// only the prefix that agrees with the PREVIOUS translation is locked in
// (committedPrefix, monotonic — never shrinks even if a later call disagrees
// with an already-locked part); only the tail beyond it is shown as still
// tentative. submitFinal (EndOfTurn) skips that caution and commits outright.

export interface TranslationSession {
  /** Call on each growing partial transcript. Throttled/coalesced internally. */
  submitPartial(text: string): void
  /** Call once when the utterance is finalized (EndOfTurn). */
  submitFinal(text: string): void
  dispose(): void
}

const MIN_PARTIAL_INTERVAL_MS = 500
// A hung request must not hold the session's in-flight slot forever — every
// later submitPartial would be skipped and translation would look "stopped".
const REQUEST_TIMEOUT_MS = 8000

function longestCommonPrefix(a: string, b: string): string {
  let i = 0
  const len = Math.min(a.length, b.length)
  while (i < len && a[i] === b[i]) i++
  return a.slice(0, i)
}

export function createTranslationSession(
  relayUrl: string,
  /** Translation target, as a natural-language name the model understands. */
  targetLang: string,
  render: (text: string) => void,
  /** Fires once per utterance, when its translation is finalized. */
  onCommit: (text: string) => void,
  onError?: (err: unknown) => void,
): TranslationSession {
  let inFlight = false
  let lastRequestAt = 0
  let lastSourceText = '' // source text the most recent request was for
  let lastTranslation = '' // its completed result (may still be revised by the next call)
  let committedPrefix = '' // prefix of lastTranslation locked in, never shrinks
  let controller: AbortController | null = null

  function resetForNextUtterance() {
    lastSourceText = ''
    lastTranslation = ''
    committedPrefix = ''
  }

  async function runTranslate(text: string, isFinal: boolean) {
    const myController = new AbortController()
    controller = myController
    inFlight = true
    lastRequestAt = Date.now()
    lastSourceText = text

    let timedOut = false
    const watchdog = setTimeout(() => {
      timedOut = true
      myController.abort()
    }, REQUEST_TIMEOUT_MS)

    try {
      const res = await fetch(`${relayUrl}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, targetLang }),
        signal: myController.signal,
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

      if (isFinal) {
        // Commit ends the segment: onCommit archives the translation into the
        // transcript. Rendering here as well would ALSO put the same text
        // into the live view, so the segment would show up twice (history +
        // current) until the next partial overwrote it.
        committedPrefix = full
        lastTranslation = full
        onCommit(full)
        return
      }
      const agreed = longestCommonPrefix(lastTranslation, full)
      if (agreed.length > committedPrefix.length) committedPrefix = agreed
      lastTranslation = full
      render(committedPrefix + full.slice(committedPrefix.length))
    } catch (err) {
      if (timedOut) onError?.(new Error('translate request timed out'))
      else if ((err as Error)?.name !== 'AbortError') onError?.(err)
    } finally {
      clearTimeout(watchdog)
      // A newer call may already have replaced `controller` (submitFinal
      // aborts and immediately starts one) — only the current owner clears it.
      if (controller === myController) {
        inFlight = false
        controller = null
      }
    }
  }

  return {
    submitPartial(text) {
      if (!text || text === lastSourceText) return
      if (inFlight) return
      if (Date.now() - lastRequestAt < MIN_PARTIAL_INTERVAL_MS) return
      runTranslate(text, false)
    },
    submitFinal(text) {
      if (!inFlight && text === lastSourceText && lastTranslation) {
        // Already fully translated by the last partial — archive it directly.
        // No render: the live view already holds this text.
        onCommit(lastTranslation)
        resetForNextUtterance()
        return
      }
      controller?.abort()
      runTranslate(text, true).then(resetForNextUtterance)
    },
    dispose() {
      controller?.abort()
    },
  }
}
