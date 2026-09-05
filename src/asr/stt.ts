// Soniox stt-rt-v5 real-time speech-to-text client — browser-direct WebSocket.
//
// Auth: the user's own Soniox key goes in the first JSON config message on the
// socket; no relay hop and no token minting. (Soniox's temporary-key flow
// exists for apps that must not hand a master key to untrusted visitors —
// this app carries the user's own key from their own phone.)
//
// Protocol (verified against a live connection): the first text message is the
// config, audio goes out as binary frames. Each response carries the NON-FINAL
// tokens (still revisable, re-sent on every response) plus the final tokens
// that NEWLY stabilized — per Soniox's contract a final token is sent exactly
// once and never repeated. An `<end>` token marks the utterance boundary; the
// next response starts a fresh utterance. The callbacks pass that structure
// through 1:1, as increments — nothing is accumulated here, so the consumer
// never has to guess what it has already seen:
//   onStable(text, langs) — text that NEWLY stabilized in this response
//   (protocol delta, sent exactly once, never repeated).
//   onLive(live, langs) — the utterance's current revisable draft tail;
//   replaces whatever a previous onLive delivered.
//   onEnd(tail, langs) — once per `<end>`: the part of the utterance that
//   never went out as onStable (the last delta plus the final draft tail).
//   An empty tail means everything was already delivered as stable text.
//   The Langs arrays carry the per-character source language parallel to
//   each part.
//
// Language identification is per token (`language` field). Hints are bias
// only — strict mode is off on purpose: speech in an unselected language comes
// back transcribed in its own language and the filter below drops it, so the
// display stays silent instead of forcing the words into a hinted language
// (with `language_hints_strict` the model could only emit hinted languages, so
// Chinese speech arrived as misheard English). Two nets drop tokens before
// they reach the caller: tokens carrying letters from a writing system none of
// the hinted languages uses, tokens tagged with a language outside
// `languageHints`. The script net exists because the tag net alone is
// not trustworthy: with hints set, the model emits unselected-language speech
// as its own script but mislabels the tokens with a hinted language (observed:
// nearby Chinese speech arrived as accurate, confident tokens tagged `en`), so
// the token's visible characters are the only reliable signal. Source speech
// may not borrow words written in an unselected language's script. Tokens
// with no language (spaces, punctuation, markers) are kept.
//
// Confidence describes individual tokens, which can be fragments of one word.
// Preserve all fragments of accepted-language text regardless of confidence;
// deleting individual fragments can truncate words.
//
// That per-token language also reaches the caller: the callbacks carry a
// per-character language array parallel to the text (entries are undefined for
// characters from language-less tokens), so main.ts can decide per sealed
// segment whether the speech is already in the target language and skip
// translation for it.

import { diagnostics } from '../diagnostics'

/** Per-character source language, parallel to a callback's text. */
export type CharLangs = (string | undefined)[]

// One regex per writing system a hinted language can produce. Letters only:
// digits and punctuation are language-neutral and never drop a token, so a
// transcript keeps its numbers and marks whatever the session's languages.
const TOKEN_SCRIPTS: [string, RegExp][] = [
  ['lat', /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/],
  ['cyr', /[\u0400-\u04FF]/],
  ['deva', /[\u0900-\u097F]/],
  ['han', /[\u3400-\u9FFF\uF900-\uFAFF]/],
  ['kana', /[\u3040-\u30FF]/],
  ['hang', /[\uAC00-\uD7AF]/],
]

// The writing systems each hint language is written in (ja carries kanji).
// A hint outside this map turns the script net off entirely — filtering a
// language the map does not know would be guesswork.
const LANG_SCRIPTS: Record<string, string[]> = {
  en: ['lat'],
  es: ['lat'],
  fr: ['lat'],
  de: ['lat'],
  pt: ['lat'],
  it: ['lat'],
  nl: ['lat'],
  ru: ['cyr'],
  hi: ['deva'],
  zh: ['han'],
  ja: ['kana', 'han'],
  ko: ['hang'],
}

export interface SttClient {
  sendPcm(chunk: Uint8Array): void
  close(): void
}

export class SttError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message)
    this.name = 'SttError'
  }
}

// Soniox returns a normal WebSocket close even for API errors. Use the
// stable error_type from its JSON frame to decide whether speech can retry.
const RETRYABLE_ERRORS = new Set([
  'request_timeout', 'service_unavailable', 'internal_error',
  'max_duration_reached', 'max_concurrent_streams_reached', 'limit_exceeded',
])

export interface StartSonioxStreamOptions {
  /** The user's own Soniox API key. */
  apiKey: string
  /** 1-3 ISO language codes to listen for. */
  languageHints: string[]
  /** Fires per response: text that newly stabilized (sent exactly once). */
  onStable(text: string, langs: CharLangs): void
  /** Fires per response: the current revisable draft tail, replacing the
   *  previous call's value (may be ''). */
  onLive(live: string, langs: CharLangs): void
  /** Fires once per `<end>`: the utterance's never-confirmed remainder. */
  onEnd(tail: string, langs: CharLangs): void
  onError?: (err: unknown) => void
  /** Diagnostics: a token dropped by one of the nets (text, reason: script /
   *  tag language). */
  onDrop?(text: string, lang: string): void
}

interface SonioxToken {
  text?: string
  language?: string
  is_final?: boolean
}

interface SonioxMessage {
  tokens?: SonioxToken[]
  finished?: boolean
  error_type?: string
  error_message?: string
  error_code?: number
  request_id?: string
}

export async function startSonioxStream(opts: StartSonioxStreamOptions): Promise<SttClient> {
  diagnostics.protect([opts.apiKey])
  const connection = diagnostics.count('stt.connections')
  const startedAt = Date.now()
  let lastSentAt = 0
  diagnostics.log('stt', 'connect', { connection, languages: opts.languageHints.join(','), model: 'stt-rt-v5' })
  const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket')
  const allowed = new Set(opts.languageHints.map(code => code.toLowerCase()))
  // Script net's allow-set. Off unless every hint is a language the map
  // knows — filtering an unknown language would be guesswork.
  const scriptNetOn =
    opts.languageHints.length > 0 && opts.languageHints.every(code => LANG_SCRIPTS[code.toLowerCase()] !== undefined)
  const allowedScripts = new Set(
    scriptNetOn ? opts.languageHints.flatMap(code => LANG_SCRIPTS[code.toLowerCase()]) : [],
  )

  const sendPcm = (chunk: Uint8Array) => {
    // Frames arriving before the handshake completes are dropped — the mic
    // only comes up after the page is built anyway.
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(chunk as Uint8Array<ArrayBuffer>)
      lastSentAt = Date.now()
      diagnostics.count('stt.sentFrames')
      diagnostics.count('stt.sentBytes', chunk.length)
      diagnostics.gauge('stt.bufferedBytes', ws.bufferedAmount ?? 0)
      diagnostics.gauge('stt.lastSentAt', lastSentAt)
    } else diagnostics.count('stt.unsentBytes', chunk.length)
  }

  return new Promise<SttClient>((resolve, reject) => {
    let stopped = false
    const openTimer = setTimeout(() => fail(new SttError('Soniox WebSocket connection timed out')), 20_000)

    // Billing counts connection time. Both local shutdown and failure must
    // retire the socket immediately, including a handshake that never opens.
    function close() {
      if (stopped) return
      diagnostics.log('stt', 'close_requested', { connection, readyState: ws.readyState, ageMs: Date.now() - startedAt })
      stopped = true
      clearTimeout(openTimer)
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send('')
      } catch {
        // Socket already gone — closing is all that matters.
      }
      try {
        ws.close(1000)
      } catch {
        // The transport has already closed.
      }
    }

    function fail(err: SttError, details: Record<string, unknown> = {}) {
      if (stopped) return
      diagnostics.error('stt', 'error', err, {
        connection, retryable: err.retryable, readyState: ws.readyState,
        lastSendAgeMs: lastSentAt ? Date.now() - lastSentAt : null, ...details,
      })
      close()
      reject(err)
      opts.onError?.(err)
    }

    ws.onopen = () => {
      if (stopped) return
      clearTimeout(openTimer)
      diagnostics.log('stt', 'open', { connection, elapsedMs: Date.now() - startedAt })
      try {
        ws.send(
          JSON.stringify({
            api_key: opts.apiKey,
            model: 'stt-rt-v5',
            audio_format: 'pcm_s16le',
            num_channels: 1,
            sample_rate: 16000,
            enable_language_identification: true,
            enable_endpoint_detection: true,
            max_endpoint_delay_ms: 1320,
            language_hints: opts.languageHints,
          }),
        )
      } catch {
        fail(new SttError('Soniox WebSocket configuration send failed'))
        return
      }
      resolve({ sendPcm, close })
    }

    ws.onerror = () => fail(new SttError('Soniox WebSocket connection error'))

    ws.onclose = event => {
      diagnostics.log('stt', 'closed', { connection, code: event.code, reason: event.reason, wasClean: event.wasClean })
      fail(new SttError(`Soniox socket closed: ${event.code} ${event.reason}`))
    }

    ws.onmessage = event => {
      diagnostics.count('stt.responses')
      diagnostics.gauge('stt.lastResponseAt', Date.now())
      let msg: SonioxMessage
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '') as SonioxMessage
      } catch {
        diagnostics.log('stt', 'invalid_response', { connection })
        return
      }
      if (msg.error_type) {
        fail(new SttError(
          `Soniox: ${msg.error_type} — ${msg.error_message ?? 'unknown error'}`,
          RETRYABLE_ERRORS.has(msg.error_type.toLowerCase()),
        ), { errorType: msg.error_type, errorCode: msg.error_code, requestId: msg.request_id })
        return
      }
      if (msg.finished) return // ack for our end-of-stream frame; socket is about to close
      if (!Array.isArray(msg.tokens)) return
      diagnostics.count('stt.tokens', msg.tokens.length)

      let delta = ''
      let live = ''
      const deltaLangs: CharLangs = []
      const liveLangs: CharLangs = []
      let utteranceEnded = false
      for (const token of msg.tokens) {
        if (token.text === '<end>') {
          utteranceEnded = true
          continue
        }
        // Structural stream opener — no text, never part of a transcript.
        if (token.text === '<docroot>') continue
        const text = token.text ?? ''
        // Script net — shape-based, independent of the (mislabel-prone)
        // language tag: letters from a writing system no hinted language
        // uses cannot be this session's speech, however the token is labeled.
        if (scriptNetOn && TOKEN_SCRIPTS.some(([name, re]) => re.test(text) && !allowedScripts.has(name))) {
          diagnostics.count('stt.droppedScript')
          opts.onDrop?.(text, 'script')
          continue
        }
        if (token.language && allowed.size > 0 && !allowed.has(token.language.toLowerCase())) {
          diagnostics.count('stt.droppedLanguage')
          opts.onDrop?.(text, token.language)
          continue
        }
        if (token.is_final) {
          delta += text
          for (let i = 0; i < text.length; i++) deltaLangs.push(token.language)
        } else {
          live += text
          for (let i = 0; i < text.length; i++) liveLangs.push(token.language)
        }
      }

      if (utteranceEnded) {
        // The utterance is over: whatever never stabilized (this response's
        // delta plus the draft tail) leaves as one tail. Everything the
        // earlier responses carried already went out through onStable.
        opts.onEnd(delta + live, [...deltaLangs, ...liveLangs])
      } else {
        if (delta) opts.onStable(delta, deltaLangs)
        opts.onLive(live, liveLangs)
      }
    }
  })
}
