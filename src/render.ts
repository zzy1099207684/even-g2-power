// Shared glasses-container writer: debounce (120ms), pixel-fit text to a box
// via pretext, and serialize writes across containers through one queue so
// two containers updating at once can't race the BLE link.

import { measureTextWrap } from '@evenrealities/pretext'
import { TextContainerUpgrade, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { diagnostics } from './diagnostics'

const DEBOUNCE_MS = 120

// A glasses write that never answers (host asleep, BLE wedged) must not stall
// the shared queue forever: past this, the write is abandoned and the queue
// moves on, so the display recovers on its own once the link comes back.
const WRITE_TIMEOUT_MS = 3000

export interface ContainerBox {
  innerWidth: number
  maxLines: number
}

export interface WriteQueue {
  current: Promise<unknown>
}

export function createWriteQueue(): WriteQueue {
  return { current: Promise.resolve() }
}

// Longest suffix of `text` that fits within maxLines at innerWidth.
export function fitTail(text: string, innerWidth: number, maxLines: number): string {
  if (!text) return text

  // The display can never hold more than maxLines lines, so anything before
  // this tail window is guaranteed trimmed output regardless — measure only
  // the window and the fitting cost stays constant no matter how long the
  // transcript grows. (100 chars/line is a generous upper bound for the
  // glasses font at these container widths.)
  const windowStart = Math.max(0, text.length - maxLines * 100)
  if (windowStart > 0) text = text.slice(windowStart)

  if (measureTextWrap(text, innerWidth).lineCount <= maxLines) return text

  // Space-separated scripts (English, German, ...): trim whole words from the
  // front first, so the visible tail doesn't start mid-word.
  const words = text.split(/(\s+)/)
  if (words.length > 1) {
    for (let start = 1; start < words.length; start++) {
      const candidate = words.slice(start).join('').trimStart()
      if (measureTextWrap(candidate, innerWidth).lineCount <= maxLines) return candidate
    }
  }

  // No whitespace to split on (Chinese, Japanese have no spaces between
  // words — the translation output is always Chinese) — word-splitting
  // degenerates to the whole string and never finds a fit. Binary-search the
  // shortest character tail instead: trimming more from the front never
  // un-fits it, so this is safe and avoids O(n) measureTextWrap calls on a
  // long paragraph.
  let lo = 1
  let hi = text.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (measureTextWrap(text.slice(mid), innerWidth).lineCount <= maxLines) hi = mid
    else lo = mid + 1
  }
  return text.slice(lo)
}

export interface ContainerRenderer {
  /** Debounced pixel-fit write to the glasses. */
  schedule(rawText: string): void
  /** Send pending text now; resolves after this write leaves the shared queue. */
  flush(): Promise<unknown>
  /** Update the geometry used by future schedule() calls. */
  setBox(box: ContainerBox): void
  /** Forget the last written content so the next schedule() writes again. */
  reset(): void
  /** Drop any pending debounced write (e.g. its container is about to go away). */
  cancel(): void
}

export function createContainerRenderer(
  bridge: EvenAppBridge,
  queue: WriteQueue,
  containerID: number,
  containerName: string,
  initialBox: ContainerBox,
): ContainerRenderer {
  let box = initialBox
  let pendingText = ''
  let lastWritten: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function writeNow() {
    timer = null
    const content = fitTail(pendingText, box.innerWidth, box.maxLines) || ' '
    if (content === lastWritten) return
    lastWritten = content
    queue.current = queue.current
      .then(async () => {
        const startedAt = Date.now()
        diagnostics.count('glasses.writes')
        let timeoutId: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`write timed out after ${WRITE_TIMEOUT_MS}ms`)),
            WRITE_TIMEOUT_MS,
          )
        })
        try {
          const result = await Promise.race([
            bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID, containerName, content })),
            timeout,
          ])
          // Firmware rejects are otherwise invisible — a failed write leaves the
          // glasses showing stale content while the phone looks fine.
          if (result === false || (typeof result === 'number' && result !== 0)) {
            diagnostics.error('glasses', 'write_rejected', new Error('textContainerUpgrade rejected'), { containerID, containerName, result })
          } else diagnostics.count('glasses.writesOk')
          diagnostics.gauge('glasses.lastWriteMs', Date.now() - startedAt)
        } finally {
          clearTimeout(timeoutId)
        }
      })
      .catch(err => {
        // A rejected write must not poison the shared queue chain — one flaky
        // BLE/host error would otherwise kill every write that follows.
        diagnostics.error('glasses', 'write_failed', err, { containerID, containerName })
        // A write that died or timed out may never have reached the glasses —
        // forget it so the next schedule() with the same content retries
        // instead of being skipped as already-written.
        if (lastWritten === content) lastWritten = null
      })
  }

  return {
    schedule(text) {
      pendingText = text
      if (timer !== null) return
      timer = setTimeout(writeNow, DEBOUNCE_MS)
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer)
        writeNow()
      }
      return queue.current
    },
    setBox(newBox) {
      box = newBox
      lastWritten = null // force a rewrite against the new geometry
    },
    reset() {
      lastWritten = null
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      pendingText = ''
    },
  }
}
