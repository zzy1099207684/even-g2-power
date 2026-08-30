// Growing conversation log: committed (sealed) segments plus the current
// in-progress segment. Everything the glasses show as "live" is ONE
// continuous text per lane (original / translation): sealed segments stay,
// new text appends after a newline, and render.ts's fitTail keeps only the
// visible tail — so on screen new content appears to push finished lines
// upward, like a scrolling document. There is never a blank frame between
// segments.
//
// Two independent "views" onto the same data:
//   - glasses: live = full continuous text (tail shown); scrolling back trims
//     whole segments off the tail of BOTH lanes — segments are pairs in
//     `history`, so original and translation stay aligned while scrolling,
//     and the view slides smoothly instead of jumping to another entry. Any
//     new content snaps back to live.
//   - phone: the full live text in a CSS scroll box — free to browse without
//     being interrupted by new content.

export interface TranscriptEntry {
  original: string
  translation: string
}

export interface Transcript {
  updateCurrentOriginal(text: string): void
  updateCurrentTranslation(text: string): void
  /** Original sealed into the log (forced cut or EndOfTurn). */
  commitOriginal(text: string): void
  /** Translation finalized for the segment whose original was just committed. */
  commitTranslation(text: string): void

  scrollOlder(): void
  scrollNewer(): void
  isAtLive(): boolean

  getGlassesOriginal(): string
  getGlassesTranslation(): string
  getFullOriginal(): string
  getFullTranslation(): string
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

export function createTranscript(): Transcript {
  const history: TranscriptEntry[] = []
  let sealedOriginal = ''
  let sealedTranslation = ''
  let currentOriginal = ''
  let currentTranslation = ''
  let pendingOriginal: string | null = null
  // Browse position in segments back from live (0 = live tail). 1 shows every
  // sealed segment but not the still-changing current one; each further step
  // trims one more segment off the tail — same segment from both lanes, so
  // they scroll in lockstep.
  let scrollBack = 0

  // The scrolled-back view: history minus the trimmed tail, newline-joined.
  const scrolled = (pick: (e: TranscriptEntry) => string): string =>
    history
      .slice(0, Math.max(0, history.length - (scrollBack - 1)))
      .map(pick)
      .join('\n')

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
      sealedOriginal = joinLane(sealedOriginal, text)
      pendingOriginal = text
      currentOriginal = ''
      scrollBack = 0
    },
    commitTranslation(text) {
      if (pendingOriginal === null) return // no sealed original waiting — nothing to pair it with
      history.push({ original: pendingOriginal, translation: text })
      pendingOriginal = null
      sealedTranslation = joinLane(sealedTranslation, text)
      currentTranslation = ''
      scrollBack = 0
    },
    scrollOlder() {
      scrollBack = Math.min(scrollBack + 1, history.length)
    },
    scrollNewer() {
      scrollBack = Math.max(0, scrollBack - 1)
    },
    isAtLive() {
      return scrollBack === 0
    },
    getGlassesOriginal() {
      return scrollBack === 0
        ? joinLane(sealedOriginal, currentOriginal)
        : scrolled(e => e.original)
    },
    getGlassesTranslation() {
      return scrollBack === 0
        ? joinLane(sealedTranslation, currentTranslation)
        : scrolled(e => e.translation)
    },
    getFullOriginal() {
      return joinLane(sealedOriginal, currentOriginal)
    },
    getFullTranslation() {
      return joinLane(sealedTranslation, currentTranslation)
    },
  }
}
