// Splits the ASR stream into complete sentences and hands each one out
// EXACTLY ONCE. The contract with the caller is the plain pipeline: a
// sentence is cut, committed, and done — nothing committed is ever looked
// at again.
//
// Input arrives as increments (see stt.ts):
//   addStable(text)  — newly stabilized text; the protocol sends each token
//                      exactly once, so this never repeats content.
//   setLive(live)    — the utterance's revisable draft tail; replaces the
//                      previous draft wholesale.
//   end(tail)        — the utterance boundary: the never-confirmed remainder
//                      is committed even without a sentence break.
//
// State is one small workspace: the stable text that has not yet formed a
// complete sentence, plus the live draft. Complete sentences are committed
// out of the workspace as they form; only the unfinished remainder stays.
// The one legitimate repeat in the pipeline is a sentence committed early
// from the draft that later shows up again as its stable-confirmation copy
// (or still sits in the draft when the next increment lands) — those copies
// are peeled against the recently-committed set below. That set only ever
// has to cover a couple of draft sentences, never the conversation: stable
// text is a one-shot delta, so committed history can never re-enter the
// workspace and the peel set cannot overflow the way a whole-utterance
// rescan would.

import type { CharLangs } from './asr/stt'

export interface Segmenter {
  /** Newly stabilized text (protocol delta — sent exactly once). */
  addStable(text: string, langs: CharLangs): void
  /** The current revisable draft tail; replaces the previous value. */
  setLive(live: string, langs: CharLangs): void
  /** Utterance ended: commit the never-confirmed remainder. */
  end(tail: string, langs: CharLangs): void
  /** The not-yet-committed workspace text — what the live line should show. */
  getPendingText(): string
}

export function createSegmenter(callbacks: {
  /** One complete sentence, in speech order, exactly once per sentence. */
  commit(text: string, langs: CharLangs): void
}): Segmenter {
  // Stable text that has not yet formed a complete sentence, and the current
  // draft. The workspace is the concatenation stable + live; drain() commits
  // what has become complete and writes the remainder back.
  let stable = ''
  let stableLangs: CharLangs = []
  let live = ''
  let liveLangs: CharLangs = []

  // Recently committed segments (verbatim, whitespace included) — the peel
  // set. Holds BOTH forms of every commit: the full scanned span (so a
  // stable-confirmation copy that glues the sentence around new text
  // end-matches it) and the peeled survivor (so a growing re-emission
  // prefix-matches it and only the growth is new). Reset per session by
  // creating a fresh Segmenter.
  const sealed: string[] = []

  function markSealed(segment: string): void {
    sealed.push(segment)
    if (sealed.length > 24) sealed.shift()
  }

  // A standalone commit must span at least this many chars (measured from the
  // previous commit, punctuation included). Shorter clauses ride along and
  // merge into the next span — stray ASR punctuation doesn't chop the flow.
  const MIN_SENT_CHARS = 5
  const ASCII_BREAKS = '.!?…,'
  const CJK_BREAKS = '。！？，'
  // Break punctuation as a character class, for stripping it in normSpan.
  const BREAK_PUNCT_RE = new RegExp(`[${ASCII_BREAKS}${CJK_BREAKS}]`, 'g')

  // ASCII breaks only count at the end of text or before a space — punctuation
  // glued to the next character is part of a token (decimals "3.5",
  // abbreviations "e.g."), not a clause boundary. CJK breaks always count.
  function isBreak(text: string, i: number): boolean {
    const ch = text[i]
    if (CJK_BREAKS.includes(ch)) return true
    if (ASCII_BREAKS.includes(ch)) {
      const next = text[i + 1]
      return next === undefined || next === ' '
    }
    return false
  }

  // Dedupe form of a span: lowercased, break punctuation stripped, spaces
  // collapsed. Confirmation copies of a committed sentence differ from it
  // only in surface detail — the engine drifts the boundary punctuation
  // ("." → ",") and casing — so peel matching runs on this form.
  // Punctuation-only spans normalize to '' and are guarded against in the
  // match loop.
  function normSpan(s: string): string {
    return s.toLowerCase().replace(BREAK_PUNCT_RE, '').trim().replace(/\s+/g, ' ')
  }

  // The raw span left after the stretch that normalizes to `normPrev` is cut
  // away — the head when the re-heard span ends with the committed copy
  // (fromEnd), else the tail. The cut walks the raw span counting normalized
  // characters (normSpan rules), so punctuation drifted inside the repeated
  // stretch shifts it without breaking the match. '' when nothing is left.
  function spanExtra(raw: string, normPrev: string, fromEnd: boolean): string {
    let acc = ''
    if (fromEnd) {
      for (let i = raw.length - 1; i >= 0; i--) {
        const ch = raw[i]
        if (ASCII_BREAKS.includes(ch) || CJK_BREAKS.includes(ch)) continue
        if (ch === ' ') {
          if (!acc || acc.startsWith(' ')) continue
          acc = ` ${acc}`
        } else {
          acc = ch.toLowerCase() + acc
          if (acc.length >= normPrev.length) return raw.slice(0, i)
        }
      }
      return ''
    }
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i]
      if (ASCII_BREAKS.includes(ch) || CJK_BREAKS.includes(ch)) continue
      if (ch === ' ') {
        if (!acc || acc.endsWith(' ')) continue
        acc += ' '
      } else {
        acc += ch.toLowerCase()
        if (acc.length >= normPrev.length) return raw.slice(i + 1)
      }
    }
    return ''
  }

  // The most recent committed span that `text` repeats — verbatim, with
  // drifted boundary punctuation ("." → ","), or glued into longer text with
  // the copy at one end. Matching runs on normSpan forms; `same` marks a full
  // repeat, otherwise `fromEnd` says which end the copy sits at. undefined
  // when the text carries new content only.
  //
  // The engine also re-confirms already-committed content in shrinking
  // pieces: a sentence committed from the draft later arrives as stable
  // deltas that are the committed span's TAIL with progressively less and
  // less of it ("... World zurück," → "Nutzer von Codex und ChatGPT World
  // zurück," → "T World zurück."). Those are the inverse of the glue case —
  // the new span is a tail copy of the committed one — and are discarded
  // wholesale (same), because none of the text is new.
  function findRepeated(text: string): { prev: string; same: boolean; fromEnd: boolean } | undefined {
    const norm = normSpan(text)
    for (const prev of sealed) {
      const normPrev = normSpan(prev)
      if (!normPrev) continue
      if (norm === normPrev) return { prev, same: true, fromEnd: false }
      if (norm.startsWith(normPrev) || norm.endsWith(normPrev))
        return { prev, same: false, fromEnd: norm.endsWith(normPrev) }
      if (normPrev.endsWith(norm)) return { prev, same: true, fromEnd: false }
    }
    return undefined
  }

  // Peels committed copies off BOTH ends of `text`, repeatedly: one peel can
  // leave ANOTHER committed copy as the leftover. Loops until neither end
  // matches a sealed copy, so only genuinely new text survives — '' when
  // everything in `text` was already committed. `cutFrom` is the char offset
  // of the survivor inside `text` (for langs slicing).
  function peelRepeated(text: string): { text: string; cutFrom: number } {
    let work = text
    let cutFrom = 0
    for (let i = 0; i < 10; i++) {
      const repeated = findRepeated(work)
      if (!repeated) break
      if (repeated.same) work = ''
      else {
        const next = spanExtra(work, normSpan(repeated.prev), repeated.fromEnd)
        if (!repeated.fromEnd) cutFrom += work.length - next.length
        work = next
      }
    }
    // The peel seam can leave a leading punctuation mark (",0 …") — segments
    // never start with a stray one, so drop it and shift cutFrom to match.
    const seam = work.match(/^[^\s\w一-鿿]+/)
    if (seam) return { text: work.slice(seam[0].length), cutFrom: cutFrom + seam[0].length }
    return { text: work, cutFrom }
  }

  // Hands one clause out: trimmed, with its langs slice trimmed to match so
  // text and per-character languages stay aligned.
  function commitClause(raw: string, rawStart: number, langs: CharLangs): void {
    const lead = raw.length - raw.trimStart().length
    const text = raw.trim()
    callbacks.commit(text, langs.slice(rawStart + lead, rawStart + lead + text.length))
  }

  // Commits every complete clause in the workspace and writes the unfinished
  // remainder back. Each clause is peeled against the sealed set first, so a
  // draft-committed sentence's stable-confirmation copy passes through as
  // nothing. langs is parallel to stable + live.
  function drain(): void {
    const full = stable + live
    if (!full) return
    const langs = stableLangs.concat(liveLangs)
    let lastEnd = 0
    for (let i = 0; i < full.length; i++) {
      if (!isBreak(full, i)) continue
      const span = full.slice(lastEnd, i + 1)
      if (span.trim().length < MIN_SENT_CHARS) continue // merge into the next span
      const peeled = peelRepeated(span)
      if (peeled.text.trim().length >= MIN_SENT_CHARS) {
        markSealed(span)
        if (peeled.text !== span) markSealed(peeled.text)
        commitClause(peeled.text, lastEnd + peeled.cutFrom, langs)
      }
      lastEnd = i + 1
    }
    // Write the unfinished remainder back to its own half of the workspace.
    if (lastEnd >= stable.length) {
      stable = ''
      stableLangs = []
      live = full.slice(lastEnd)
      liveLangs = langs.slice(lastEnd)
    } else {
      stable = stable.slice(lastEnd)
      stableLangs = stableLangs.slice(lastEnd)
    }
  }

  return {
    addStable(text, langs) {
      if (!text) return
      stable += text
      stableLangs = stableLangs.concat(langs)
      drain()
    },

    setLive(next, langs) {
      live = next
      liveLangs = [...langs]
      drain()
    },

    // The utterance is over: the tail carries the never-confirmed remainder
    // (the live draft's latest form is inside it, so the draft half of the
    // workspace is dropped, not merged). Everything left — with or without a
    // sentence break — is committed now, and the workspace empties: the next
    // utterance starts clean.
    end(tail, langs) {
      const full = stable + tail
      const allLangs = stableLangs.concat(langs)
      live = ''
      liveLangs = []
      let lastEnd = 0
      for (let i = 0; i < full.length; i++) {
        if (!isBreak(full, i)) continue
        const span = full.slice(lastEnd, i + 1)
        if (span.trim().length < MIN_SENT_CHARS) continue
        const peeled = peelRepeated(span)
        if (peeled.text.trim().length >= MIN_SENT_CHARS) {
          markSealed(span)
          if (peeled.text !== span) markSealed(peeled.text)
          commitClause(peeled.text, lastEnd + peeled.cutFrom, allLangs)
        }
        lastEnd = i + 1
      }
      // Whatever the clause scan left has no sentence break — it is the
      // spoken tail fragment; peel it and commit it as-is.
      const remainder = full.slice(lastEnd)
      if (remainder.trim()) {
        const peeled = peelRepeated(remainder)
        if (peeled.text.trim()) {
          markSealed(remainder)
          if (peeled.text !== remainder) markSealed(peeled.text)
          commitClause(peeled.text, lastEnd + peeled.cutFrom, allLangs)
        }
      }
      stable = ''
      stableLangs = []
    },

    getPendingText() {
      return (stable + live).trimStart()
    },
  }
}
