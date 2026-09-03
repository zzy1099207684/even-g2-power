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
// Chinese speech arrived as misheard English). The filter is now the only net:
// tokens tagged with a language outside `languageHints` are dropped. Cost of
// dropping strict: heavily accented speech in a hinted language is occasionally
// mis-tagged to another language and lost the same way. Tokens with no language
// (spaces, punctuation, markers) are kept.
//
// That per-token language also reaches the caller: the callbacks carry a
// per-character language array parallel to the text (entries are undefined for
// characters from language-less tokens), so main.ts can decide per sealed
// segment whether the speech is already in the target language and skip
// translation for it.

/** Per-character source language, parallel to a callback's text. */
export type CharLangs = (string | undefined)[]

export interface SttClient {
  sendPcm(chunk: Uint8Array): void
  close(): void
}

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
  /** Diagnostics: a token dropped by the language-hints filter (text, tagged language). */
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
}

export async function startSonioxStream(opts: StartSonioxStreamOptions): Promise<SttClient> {
  const ws = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket')
  const allowed = new Set(opts.languageHints.map(code => code.toLowerCase()))

  const sendPcm = (chunk: Uint8Array) => {
    // Frames arriving before the handshake completes are dropped — the mic
    // only comes up after the page is built anyway.
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk)
  }

  return new Promise<SttClient>((resolve, reject) => {
    ws.onopen = () => {
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
      resolve({
        sendPcm,
        // Billing counts connection time, so every exit path must actually
        // kill the socket: empty frame ends the stream server-side, close(1000)
        // tears the connection down immediately without waiting for the ack.
        close() {
          ws.onmessage = null
          try {
            if (ws.readyState === WebSocket.OPEN) ws.send('')
          } catch {
            // Socket already gone — closing is all that matters.
          }
          try {
            ws.close(1000)
          } catch {
            // Same — a socket that never opened has nothing to close.
          }
        },
      })
    }

    ws.onerror = err => {
      reject(err)
      opts.onError?.(err)
    }

    ws.onclose = event => {
      if (event.code !== 1000) opts.onError?.(new Error(`Soniox socket closed: ${event.code} ${event.reason}`))
    }

    ws.onmessage = event => {
      let msg: SonioxMessage
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '') as SonioxMessage
      } catch {
        return
      }
      if (msg.error_type) {
        opts.onError?.(new Error(`Soniox: ${msg.error_type} — ${msg.error_message ?? 'unknown error'}`))
        return
      }
      if (msg.finished) return // ack for our end-of-stream frame; socket is about to close
      if (!Array.isArray(msg.tokens)) return

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
        if (token.language && allowed.size > 0 && !allowed.has(token.language.toLowerCase())) {
          opts.onDrop?.(token.text ?? '', token.language)
          continue
        }
        const text = token.text ?? ''
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
