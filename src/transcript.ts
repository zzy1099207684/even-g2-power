// Growing conversation log: committed (sealed) segments plus the current
// pending preview. Everything the glasses show as "live" is ONE
// continuous text per lane (original / translation): sealed segments stay,
// new text appends after a newline, and render.ts's fitTail keeps only the
// visible tail — so on screen new content appears to push finished lines
// upward, like a scrolling document. There is never a blank frame between
// segments.
//
// Two independent "views" onto the same data:
//   - glasses: live = tail of the continuous text (tail shown); scrolling
//     back trims whole segments off the tail of BOTH lanes — segments are
//     pairs, so original and translation stay aligned while scrolling, and
//     the view slides smoothly instead of jumping to another entry. Any new
//     content snaps back to live.
//   - phone: the full log as line arrays in a CSS scroll box — free to
//     browse without being interrupted by new content.
//
// Storage is line arrays, never one growing string: the transcript only
// ever grows, so a whole-document string would be rebuilt and copied on
// every STT partial (several per second). The glasses getters instead serve
// a cached tail window of the sealed text — big enough that render.ts's
// fitTail (which itself only measures a maxLines*100-char suffix window)
// returns exactly what it would from the full text.

// Sealed-tail window served to the glasses. Must cover the largest fitTail
// measure window (9 lines * 100 chars = 900, render.ts FULL_BOX) with
// margin, so a fitTail call on this suffix equals a call on the full text.
const SEALED_TAIL_CHARS = 1000

export interface Transcript {
  updateCurrentOriginal(text: string): void
  /** Replace the ordered preview of pending translations, including gap placeholders. */
  updateCurrentTranslation(text: string): void
  /** Original sealed into the log (clause cut, length backstop or EndOfTurn). */
  commitOriginal(text: string): void
  /** Translation finalized for the oldest original still waiting to be paired. */
  commitTranslation(text: string): void
  /** Fresh live view after a long silence: clears both lane tails and the
   *  draft line. Sealed history, pairing queue and scroll position are
   *  untouched — scrolling and the phone mirror still reach everything. */
  cutLiveView(): void

  scrollOlder(): void
  scrollNewer(): void
  isAtLive(): boolean

  getGlassesOriginal(): string
  getGlassesTranslation(): string
  getFullOriginal(): string
  getFullTranslation(): string

  /** Sealed original segments in order — phone mirror renders these incrementally. */
  getOriginalLines(): readonly string[]
  /** Sealed (already paired) translations in order. */
  getTranslationLines(): readonly string[]
  /** The still-revising live original line, '' when nothing is live. */
  getCurrentOriginal(): string
  getCurrentTranslation(): string
}

// Sealed + current join with a newline: every sealed segment starts on its
// own line, so on screen new content appears to push finished lines upward —
// the scroll the glasses show is just fitTail trimming whole lines off the
// top. pretext's measureTextWrap treats '\n' as a hard break (mirrors the
// firmware's LVGL rendering), so line counts stay honest.
function joinLane(sealed: string, current: string): string {
  if (!sealed) return current
  if (!current) return sealed
  return `${sealed}\n${current}`
}

// Append one sealed segment to a tail window, keeping at most the last
// SEALED_TAIL_CHARS characters. Any slice point yields a true suffix of the
// full text, which is all fitTail's window math requires.
function appendTail(tail: string, text: string): string {
  const next = tail ? `${tail}\n${text}` : text
  return next.length > SEALED_TAIL_CHARS ? next.slice(next.length - SEALED_TAIL_CHARS) : next
}

export function createTranscript(): Transcript {
  // Sealed segments, append-only. origLines includes originals whose
  // translation hasn't landed yet; transLines holds only paired ones —
  // translation pairs with the oldest pending original, FIFO.
  const origLines: string[] = []
  const transLines: string[] = []
  // Originals sealed but not yet paired with a translation, in order. A
  // queue, not a single slot: clauses seal faster than translations come
  // back, so several can be waiting when the next translation lands.
  const pendingOriginals: string[] = []
  let currentOriginal = ''
  let currentTranslation = ''
  // Cached tails of the sealed lanes (last SEALED_TAIL_CHARS chars) —
  // rebuilt incrementally on commit, so per-partial glasses reads stay O(1)
  // in conversation length.
  let origTail = ''
  let transTail = ''
  // Browse position in segments back from live (0 = live tail). 1 shows every
  // sealed segment but not the still-changing current one; each further step
  // trims one more segment off the tail — same segment from both lanes, so
  // they scroll in lockstep. Scrolling only ever sees paired segments, so
  // both lanes move by transLines.length.
  let scrollBack = 0

  // The scrolled-back view: paired segments minus the trimmed tail,
  // newline-joined. Only the suffix fitTail can still see is joined — walk
  // backward from the trim point until SEALED_TAIL_CHARS accumulates (the
  // same window math as the live-tail caches: 1000 ≥ fitTail's 900-char
  // measure window, so a fitTail call on this suffix equals one on the full
  // join). Cost is constant in conversation length; output identical.
  // Only runs on a scroll gesture.
  const scrolled = (pick: (i: number) => string): string => {
    const end = Math.max(0, transLines.length - (scrollBack - 1))
    let first = end
    let total = 0
    while (first > 0) {
      total += pick(first - 1).length + 1
      first--
      if (total >= SEALED_TAIL_CHARS) break
    }
    const parts: string[] = []
    for (let i = first; i < end; i++) parts.push(pick(i))
    return parts.join('\n')
  }

  return {
    updateCurrentOriginal(text) {
      currentOriginal = text
      scrollBack = 0
    },
    updateCurrentTranslation(text) {
      currentTranslation = text
      scrollBack = 0
    },
    commitOriginal(text) {
      origLines.push(text)
      origTail = appendTail(origTail, text)
      pendingOriginals.push(text)
      currentOriginal = ''
      scrollBack = 0
    },
    commitTranslation(text) {
      const original = pendingOriginals.shift()
      if (original === undefined) return // no sealed original waiting — nothing to pair it with
      currentTranslation = ''
      transLines.push(text)
      transTail = appendTail(transTail, text)
      scrollBack = 0
    },
    // The live view restarting after a long silence: the tails rebuild from
    // the next commits, while the scrolled view and the phone mirror keep
    // reading the full sealed log.
    cutLiveView() {
      origTail = ''
      transTail = ''
      currentOriginal = ''
      currentTranslation = ''
    },
    scrollOlder() {
      scrollBack = Math.min(scrollBack + 1, transLines.length)
    },
    scrollNewer() {
      scrollBack = Math.max(0, scrollBack - 1)
    },
    isAtLive() {
      return scrollBack === 0
    },
    getGlassesOriginal() {
      return scrollBack === 0 ? joinLane(origTail, currentOriginal) : scrolled(i => origLines[i])
    },
    getGlassesTranslation() {
      return scrollBack === 0 ? joinLane(transTail, currentTranslation) : scrolled(i => transLines[i])
    },
    getFullOriginal() {
      return joinLane(origLines.join('\n'), currentOriginal)
    },
    getFullTranslation() {
      return transLines.join('\n')
    },
    getOriginalLines() {
      return origLines
    },
    getTranslationLines() {
      return transLines
    },
    getCurrentOriginal() {
      return currentOriginal
    },
    getCurrentTranslation() {
      return currentTranslation
    },
  }
}
