// Deepgram Flux (flux-general-multi) speech-to-text client.
//
// Auth: the relay mints a short-lived Deepgram token (never the master key)
// via GET /deepgram-token. Browsers can't set a custom Authorization header
// on a WebSocket handshake, so the token is passed via Sec-WebSocket-Protocol
// instead: `new WebSocket(url, ["bearer", accessToken])`. Deepgram uses
// "bearer" for these short-lived grant-endpoint JWTs and "token" for raw
// long-lived API keys — confirmed empirically, not documented.
//
// Flux reports two kinds of `{type:"TurnInfo"}` messages, confirmed against a
// live connection's raw message log: `event:"Update"` fires continuously as
// speech is recognized (its `transcript` grows across calls, mid-utterance),
// and `event:"EndOfTurn"` fires once the utterance is judged finished. Update
// is what makes live, growing captions/translation possible instead of
// waiting for a full pause.

export interface SttClient {
  sendPcm(chunk: Uint8Array): void
  close(): void
}

export interface StartFluxStreamOptions {
  relayUrl: string
  /** 1-3 of: en es fr de hi ru pt ja it nl */
  languageHints: string[]
  /** Fires on each Update, with the transcript recognized so far (may still change). */
  onPartial: (transcript: string) => void
  /** Fires once per confirmed EndOfTurn, with the finalized transcript. */
  onFinal: (transcript: string) => void
  onError?: (err: unknown) => void
}

export async function startFluxStream(opts: StartFluxStreamOptions): Promise<SttClient> {
  const tokenRes = await fetch(`${opts.relayUrl}/deepgram-token`)
  if (!tokenRes.ok) {
    throw new Error(`deepgram-token request failed: ${tokenRes.status}`)
  }
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string }

  const params = new URLSearchParams()
  params.set('model', 'flux-general-multi')
  params.set('encoding', 'linear16')
  params.set('sample_rate', '16000')
  for (const lang of opts.languageHints) params.append('language_hint', lang)

  // Deepgram distinguishes the two credential types by Sec-WebSocket-Protocol
  // keyword: a raw (long-lived) API key uses "token", but this short-lived
  // grant-endpoint JWT must use "bearer" — confirmed empirically (undocumented).
  const ws = new WebSocket(`wss://api.deepgram.com/v2/listen?${params}`, ['bearer', accessToken])

  return new Promise<SttClient>((resolve, reject) => {
    ws.onopen = () => {
      resolve({
        sendPcm(chunk) {
          if (ws.readyState === WebSocket.OPEN) ws.send(chunk)
        },
        close() {
          ws.onclose = null
          ws.close(1000)
        },
      })
    }

    ws.onerror = err => {
      reject(err)
      opts.onError?.(err)
    }

    ws.onclose = event => {
      if (event.code !== 1000) opts.onError?.(new Error(`Deepgram socket closed: ${event.code} ${event.reason}`))
    }

    ws.onmessage = event => {
      let msg: { type?: string; event?: string; transcript?: string }
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (msg.type !== 'TurnInfo' || !msg.transcript) return
      if (msg.event === 'EndOfTurn') opts.onFinal(msg.transcript)
      else if (msg.event === 'Update') opts.onPartial(msg.transcript)
    }
  })
}
