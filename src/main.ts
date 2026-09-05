import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { startSonioxStream, type CharLangs, type SttClient } from './asr/stt'
import { createTranslationSession, type TranslationSession } from './translate'
import { createTranscript, type Transcript } from './transcript'
import { createSegmenter, type Segmenter } from './segmenter'
import { addRecord, saveRecordSummary, type SessionRecord } from './history'
import { generateSummary } from './summary'
import {
  DEFAULT_SCREEN_CLEAR_SECONDS,
  MIN_SCREEN_CLEAR_SECONDS,
  loadUiConfig,
  type SessionConfig,
  type UiConfig,
} from './config'
import { mountUi, getSelectedModel, type RunningUiHandle } from './ui'
import { t } from './i18n'
import { createWriteQueue, createContainerRenderer, fitTail, type ContainerBox, type ContainerRenderer } from './render'

type DisplayMode = 'both' | 'translationOnly'

// Line height on the panel is 27px. The top 28px strip is reserved for the
// idle-marker text container, so the original lane in both mode fits 4
// lines (y 28..144) and translation keeps its 5 (y 144..288); fullscreen
// translation fits 9 (y 28..288).
const TOP_BOX: ContainerBox = { innerWidth: 568, maxLines: 4 }
const MID_BOX: ContainerBox = { innerWidth: 568, maxLines: 5 }
const FULL_BOX: ContainerBox = { innerWidth: 568, maxLines: 9 }

function originalContainerProps(): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 28, // below the idle-marker strip
    width: 576,
    height: 116,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: 1,
    containerName: 'original',
    content: ' ',
    isEventCapture: 0,
  })
}

// The idle marker lives in its own 28px text strip at the top of the page.
// paddingLength stays 0: a 27px text line plus padding would not fit.
function idleMarkerProps(): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 28,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 0,
    containerID: 3,
    containerName: 'idleMark',
    content: ' ',
    isEventCapture: 0,
  })
}

function translationContainerProps(mode: DisplayMode): TextContainerProperty {
  return mode === 'both'
    ? new TextContainerProperty({
        xPosition: 0,
        yPosition: 144,
        width: 576,
        height: 144,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 4,
        containerID: 2,
        containerName: 'translation',
        content: ' ',
        isEventCapture: 1,
      })
    : new TextContainerProperty({
        xPosition: 0,
        yPosition: 28, // below the idle-marker strip
        width: 576,
        height: 260,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 4,
        containerID: 2,
        containerName: 'translation',
        content: ' ',
        isEventCapture: 1,
      })
}

// Start the bridge handshake immediately but don't block the settings screen
// on it — mountUi() renders right away, and handleStart() awaits this promise
// only once the user has actually picked languages and tapped Start.
const bridgePromise = waitForEvenAppBridge()

// Set once handleStart resolves bridgePromise; toggleDisplayMode/cleanup/
// pause/end run only after that (they're wired up at the end of a successful
// handleStart), but are typed nullable here since they're outside
// handleStart's own scope.
let bridgeRef: Awaited<typeof bridgePromise> | null = null

let stt: SttClient | null = null
let translationSession: TranslationSession | null = null
let transcript: Transcript | null = null
let segmenter: Segmenter | null = null
let originalRenderer: ContainerRenderer | null = null
let translationRenderer: ContainerRenderer | null = null
let markerRenderer: ContainerRenderer | null = null
let runningUi: RunningUiHandle | null = null
// Mirrors the last status pushed to the phone, so code can tell whether the
// banner it wants to clear is still the one showing (e.g. a stale translate
// error) instead of blindly overwriting some newer message.
let lastStatus: { kind: 'listening' | 'error'; text: string } | null = null
let unsubscribe: (() => void) | null = null
let displayMode: DisplayMode = 'both'
let paused = false
let cleanedUp = false
let ending = false
let pageCreated = false
let summaryAbort: AbortController | null = null

// Serializes every glasses write (text + marker image) across one BLE link.
const writeQueue = createWriteQueue()
// Language selection of the running session — kept for archiving on End.
let startLanguages: string[] = []
let startTargetLang = 'Chinese (Simplified)'
// Target code for the compact on-glasses idle marker ('en/de → zh').
let startTargetCode = 'zh'

const ui = mountUi({
  onStart: handleStart,
  onPause: pauseSession,
  onResume: resumeSession,
  onEnd: endSession,
})

// The session config of the running session — Pause closes the STT socket
// (Soniox bills connection time, not speech time), and Resume needs it to
// open a fresh one.
let activeSession: SessionConfig | null = null

// Restore the last-used language selection once the bridge is up; until then
// the settings screen shows the built-in defaults.
loadUiConfig().then(cfg => {
  if (cfg) ui.applyConfig(cfg)
})

// TEMPORARY simulator-debug hooks — remove after the translate bug is found.
// ?dbgcfg=<base64url UiConfig> seeds the service config without the Settings
// screen and auto-starts the session; ?dbgpcm=<url> streams that raw 16k
// s16le mono file into the STT client instead of the glasses mic.
const dbgCfgRaw = new URLSearchParams(location.search).get('dbgcfg')
const dbgPcmUrl = new URLSearchParams(location.search).get('dbgpcm')

if (dbgCfgRaw) {
  void (async () => {
    try {
      const b64 = dbgCfgRaw.replace(/-/g, '+').replace(/_/g, '/')
      const cfg = JSON.parse(atob(b64)) as UiConfig
      ui.applyConfig(cfg)
      await bridgePromise
      const model = cfg.models.find(m => m.id === cfg.activeModelId) ?? cfg.models[0]
      const label = { 'zh-Hans': 'Chinese (Simplified)', en: 'English' }[cfg.target] ?? cfg.target
      await handleStart(cfg.sources ?? ['zh', 'en'], cfg.target, label, {
        relayUrl: cfg.relayUrl,
        sonioxKey: cfg.sonioxKey,
        model,
        summaryEnabled: cfg.summaryEnabled === true,
        // Raw debug payload — same normalization loadUiConfig would apply.
        screenClearSeconds:
          typeof cfg.screenClearSeconds === 'number' && cfg.screenClearSeconds >= MIN_SCREEN_CLEAR_SECONDS
            ? cfg.screenClearSeconds
            : DEFAULT_SCREEN_CLEAR_SECONDS,
      })
    } catch (err) {
      console.error('dbgcfg failed:', err)
    }
  })()
}

async function startPcmFeeder(client: SttClient) {
  console.log('dbgpcm: feeding', dbgPcmUrl)
  const res = await fetch(dbgPcmUrl!)
  const pcm = new Uint8Array(await res.arrayBuffer())
  for (let off = 0; off < pcm.length; off += 3200) {
    client.sendPcm(pcm.subarray(off, Math.min(off + 3200, pcm.length)))
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  console.log('dbgpcm: feed done', pcm.length, 'bytes')
}

// TEMPORARY STT pipeline diagnostics — remove once the disappearing-text bug
// is solved. Counters cover every hop: mic bytes out, token responses in,
// `<end>` finals in, utterance commits, client errors.
const dbg = {
  partials: 0,
  finals: 0,
  commits: 0,
  errors: 0,
  dropped: 0,
  bytes: 0,
  lastLen: 0,
  lastFinalLen: 0,
  lastDrops: [] as string[],
  tSub: 0,
  tDone: 0,
  tPass: 0,
  tErr: 0,
  tLastErr: '',
  lastCommits: [] as string[],
  rms: 0,
  noiseFloor: 0,
}
let dbgTimer: ReturnType<typeof setInterval> | null = null

function renderDbg() {
  const err = dbg.tLastErr ? ` lastTErr:${dbg.tLastErr.slice(0, 60)}` : ''
  const last = dbg.lastCommits.length ? ` · L ${dbg.lastCommits.join(' | ')}` : ''
  const drops = dbg.lastDrops.length ? ` · D ${dbg.lastDrops.join(' | ')}` : ''
  runningUi?.setDebug(
    `STT p:${dbg.partials} f:${dbg.finals} c:${dbg.commits} e:${dbg.errors} d:${dbg.dropped} · ` +
      `TR sub:${dbg.tSub} done:${dbg.tDone} pass:${dbg.tPass} err:${dbg.tErr}${err}${last}${drops} · ` +
      `rms:${Math.round(dbg.rms)} nf:${Math.round(dbg.noiseFloor)}`,
  )
}

// Opens the Soniox stream. Unselected-language tokens are dropped inside the
// client (per-token language tags); stable/live/end increments reach here and
// go straight into the segmenter, which commits each completed sentence
// exactly once. Soniox kills idle sessions server-side (observed:
// REQUEST_TIMEOUT after a long silence), so errors here trigger a bounded
// auto-reconnect.
let sttRetries = 0
let sttGen = 0

// Idle disconnect: Soniox bills the full stream duration, so silence beyond
// IDLE_DISCONNECT_AFTER_MS closes the socket. audioControl stays on — audio
// events keep arriving and wake the stream back up. Two filters decide "this
// is speech": a local one (RMS well above the learned room noise floor) and
// Soniox itself (a woken socket that recognizes no token within
// IDLE_VERIFY_AFTER_MS was noise — it gets dropped and put on a cooldown).
// Keep a short onset window before a wake, then every frame through the
// handshake, so the new socket gets quiet syllables as well as loud ones.
const IDLE_DISCONNECT_AFTER_MS = 15_000
const IDLE_WAKE_FACTOR = 1.5 // initial balanced setting; calibrate with device audio
const IDLE_WAKE_RMS_MIN = 250 // absolute floor, so a dead-silent room still needs a real voice
const IDLE_VERIFY_AFTER_MS = 5_000 // woken but no tokens by then → it was noise
const IDLE_WAKE_SUPPRESS_MS = 2_000 // cooldown after a noise false-positive
const IDLE_PRE_ROLL_PCM_CAP = 25_600 // 800ms @16kHz s16le before the wake trigger
const IDLE_WAKE_PCM_CAP = 320_000 // ~10s @16kHz s16le — bounds memory if reconnects stall
const NOISE_FLOOR_ALPHA = 0.05 // EMA step, ~2s time constant @100ms frames

// Send gate: while the stream is connected, frames at room-noise level are
// not forwarded. Far-field or muffled voices arrive barely above the floor
// (observed: a mumble at rms 189 vs floor 187) yet Soniox transcribes them
// confidently into hinted-language words, so keeping them off the wire is the
// only reliable net. After a loud frame the gate stays open briefly so the
// quiet syllables of real near speech are not chopped.
const SEND_GATE_FACTOR = 1.1 // forward frames louder than floor × this
const SEND_GATE_HOLD_MS = 2_500 // keep forwarding this long after a loud frame

let idleDisconnected = false
let waking = false
let wakePcm: Uint8Array[] = []
let wakePcmBytes = 0
let wakeRequested = false // quiet pre-roll alone must never reopen the socket
let lastWakeAttemptAt = 0
// Room noise floor, learned from frames well below it (speech never raises it).
let noiseFloor = 300
let wakeVerifyPending = false // set on wake, cleared by the first recognized token
let wakeConnectedAt = 0
let wakeSuppressUntil = 0
let sendGateOpenUntil = 0 // frames forward only while now is before this

// Speech is flowing (a stable delta, a fresh draft, or the utterance tail
// just landed): keep the idle marker quiet and mirror the segmenter's
// not-yet-committed workspace as the live line. `content` marks events that
// carry stabilized text — only those may light the screen back up from the
// dim state; a noise draft repaints nothing and leaves the marker dim.
function afterSpeechEvent(content: boolean): void {
  maybeCutLiveView()
  speechStarted = true
  lastSpeechAt = Date.now()
  if (content) lastContentAt = Date.now()
  wakeVerifyPending = false // real speech on a freshly woken socket — it passes
  if (displayDim()) return
  transcript?.updateCurrentOriginal(segmenter?.getPendingText() ?? '')
  renderGlasses()
  renderPhone()
  // The marker may only hide while the event actually left text on screen —
  // hiding it over empty lanes is what blanked the glasses after a noise
  // burst that recognized nothing. Reads the just-updated draft line.
  if (speechVisible()) hideMarker()
}

async function openStt(languages: string[], session: SessionConfig): Promise<SttClient> {
  const gen = sttGen
  const client = await startSonioxStream({
    apiKey: session.sonioxKey,
    languageHints: languages,
    onStable: (text, langs) => {
      sttRetries = 0
      dbg.partials++
      dbg.lastLen = text.length
      segmenter?.addStable(text, langs)
      afterSpeechEvent(true)
    },
    onLive: (live, langs) => {
      sttRetries = 0
      // A response with no stable delta and no draft carries nothing new —
      // skip it so the previous utterance's line stays on screen through a
      // pause instead of being blanked.
      if (!live && !segmenter?.getPendingText()) return
      dbg.lastLen = live.length
      segmenter?.setLive(live, langs)
      afterSpeechEvent(false) // live draft — never lights the dim screen
    },
    onEnd: (tail, langs) => {
      sttRetries = 0
      dbg.finals++
      dbg.lastFinalLen = tail.length
      segmenter?.end(tail, langs)
      // An empty tail means nothing was recognized — noise, not speech. It
      // must not count as content, or it resets the dim clock and bypasses
      // the dim guard, leaving the marker hidden over an empty screen.
      afterSpeechEvent(tail.trim().length > 0)
    },
    onDrop: (text, lang) => {
      dbg.dropped++
      const trimmed = text.trim()
      if (trimmed) {
        dbg.lastDrops.push(`${trimmed.slice(0, 16)}(${lang})`)
        if (dbg.lastDrops.length > 3) dbg.lastDrops.shift()
      }
    },
    onError: err => {
      if (gen !== sttGen) return // a retired connection cannot reopen the current one
      dbg.errors++
      renderDbg()
      runningUi?.setStatus('error', `STT error: ${(err as Error)?.message ?? err}`)
      scheduleSttReopen()
    },
  })
  // A fresh socket restarts the idle clock — the silence check measures from
  // the moment the stream is live, not from the last session's last word.
  lastSpeechAt = Date.now()
  const sendPcm = client.sendPcm
  client.sendPcm = chunk => {
    dbg.bytes += chunk.length
    sendPcm(chunk)
  }
  return client
}

// Reopens the stream after an error unless the session is gone. Three
// consecutive failures without a recognized token in between give up (a bad
// key would otherwise loop forever).
function scheduleSttReopen() {
  // Idle-disconnect state owns reopening (speech wakes it in wakeStt); a
  // queued timer here must not fight it.
  if (!activeSession || paused || cleanedUp || idleDisconnected) return
  if (sttRetries >= 3) return
  sttRetries++
  const gen = ++sttGen
  setTimeout(async () => {
    if (gen !== sttGen || paused || cleanedUp || !activeSession || idleDisconnected) return
    try {
      stt?.close()
    } catch {
      // Socket already gone — reopening is all that matters.
    }
    try {
      stt = await openStt(startLanguages, activeSession)
      runningUi?.setStatus('listening', listeningStatusText())
    } catch (err) {
      runningUi?.setStatus('error', `STT error: ${(err as Error)?.message ?? err}`)
    }
  }, 1500)
}

// Closes the STT socket while keeping the mic streaming — the audio-event
// path below stays alive and wakes the stream back up on speech. The glasses
// display is untouched: the lanes just keep showing the last turn.
function idleDisconnectStt() {
  if (!stt) return
  stt.close()
  stt = null
  idleDisconnected = true
  runningUi?.setStatus('listening', t('Idle · mic listening, reopens on speech'))
}

// Root-mean-square of an s16le little-endian mono chunk.
function pcmRms(chunk: Uint8Array): number {
  let sumSquares = 0
  for (let off = 0; off + 1 < chunk.length; off += 2) {
    const sample = (chunk[off] | (chunk[off + 1] << 8)) << 16 >> 16
    sumSquares += sample * sample
  }
  const count = chunk.length >> 1
  return count ? Math.sqrt(sumSquares / count) : 0
}

function bufferWakePcm(pcm: Uint8Array, cap: number) {
  wakePcm.push(pcm)
  wakePcmBytes += pcm.length
  // Over cap: drop the OLDEST audio — the newest end (what was just said)
  // must survive. Before a trigger, retain only the short onset window.
  while (wakePcmBytes > cap) {
    const oldest = wakePcm.shift()!
    wakePcmBytes -= oldest.length
  }
}

function clearWakeBuffer() {
  wakePcm = []
  wakePcmBytes = 0
  wakeRequested = false
}

// Quiet idle frames build pre-roll. A loud frame latches a wake request;
// all following frames survive cooldown, retry throttling and the handshake
// up to the buffer cap. Buffered room noise alone cannot trigger a wake.
function onPcmWhileIdle(pcm: Uint8Array, rms: number) {
  if (sttRetries >= 3) return // same give-up contract as scheduleSttReopen
  const loud = rms > Math.max(noiseFloor * IDLE_WAKE_FACTOR, IDLE_WAKE_RMS_MIN)
  if (loud) wakeRequested = true
  bufferWakePcm(pcm, wakeRequested ? IDLE_WAKE_PCM_CAP : IDLE_PRE_ROLL_PCM_CAP)
  if (!wakeRequested || Date.now() < wakeSuppressUntil) return
  if (!waking) void wakeStt()
}

async function wakeStt() {
  if (!activeSession || paused || cleanedUp || !idleDisconnected || waking) return
  if (Date.now() - lastWakeAttemptAt < 1500) return
  lastWakeAttemptAt = Date.now()
  waking = true
  const gen = ++sttGen
  try {
    const client = await openStt(startLanguages, activeSession)
    if (gen !== sttGen || !activeSession || paused || cleanedUp) {
      client.close()
      return
    }
    stt = client
    idleDisconnected = false
    wakeVerifyPending = true // Soniox now adjudicates: tokens = speech, silence = noise
    wakeConnectedAt = Date.now()
    // The trigger may be long past by now; keep the following soft syllables
    // flowing for the same hold window as a loud frame on a connected stream.
    sendGateOpenUntil = wakeConnectedAt + SEND_GATE_HOLD_MS
    const buffered = wakePcm
    clearWakeBuffer()
    for (const chunk of buffered) client.sendPcm(chunk) // replay pre-handshake audio
    runningUi?.setStatus('listening', listeningStatusText())
  } catch {
    // Stay idle and retry the pending audio on later frames — no error flash for a
    // transient handshake miss. sttRetries reaching 3 (checked on the frame
    // path) ends the cycle, same contract as scheduleSttReopen.
  } finally {
    if (gen === sttGen) waking = false
  }
}

// Status text for the healthy running state — one source of truth for every
// caller that restores it after an error or a mode/pause transition.
function listeningStatusText(): string {
  return displayMode === 'both'
    ? t('Microphone live · glasses: original + translation')
    : t('Microphone live · glasses: translation only')
}

// Keeps lastStatus in step with whatever the phone is actually showing.
function wrapUiForStatusTracking(ui: RunningUiHandle): RunningUiHandle {
  return {
    ...ui,
    setStatus(kind, text) {
      lastStatus = { kind, text }
      ui.setStatus(kind, text)
    },
  }
}

async function handleStart(languages: string[], targetCode: string, targetLabel: string, session: SessionConfig) {
  if (ending || activeSession || cleanedUp) return
  startLanguages = languages
  startTargetCode = targetCode.split('-')[0] // 'zh-Hans' → 'zh' for the marker
  startTargetLang = targetLabel
  markerDimAfterMs = session.screenClearSeconds * 1_000
  ui.showConnecting()

  const bridge = await bridgePromise

  try {
    stt = await openStt(languages, session)
  } catch (err) {
    ui.showStartError((err as Error)?.message ?? t('Failed to start speech recognition'))
    return
  }
  activeSession = session
  if (dbgPcmUrl) void startPcmFeeder(stt)

  // Create once per app lifetime, then rebuild for each new session.
  // A page left by a WebView reload also needs the rebuild fallback.
  const created = pageCreated ? 1 : await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 3,
      textObject: [originalContainerProps(), translationContainerProps('both'), idleMarkerProps()],
    }),
  )
  if (created !== 0) {
    const rebuilt = await bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 3,
        textObject: [originalContainerProps(), translationContainerProps('both'), idleMarkerProps()],
      }),
    )
    if (!rebuilt) {
      stt.close()
      stt = null
      activeSession = null
      ui.showStartError(`createStartUpPageContainer failed: ${created}`)
      return
    }
  }
  bridgeRef = bridge
  pageCreated = true
  displayMode = 'both'
  paused = false
  sttRetries = 0
  lastWakeAttemptAt = 0
  wakeSuppressUntil = 0
  sendGateOpenUntil = 0
  activeRelayUrl = session.relayUrl

  await bridge.audioControl(true)

  runningUi = wrapUiForStatusTracking(ui.showRunning())
  transcript = createTranscript()
  // Cuts the ASR increments into sentences and hands each one out exactly
  // once; the commit callback routes it into the transcript + translation
  // pipeline below.
  segmenter = createSegmenter({
    commit: (text, langs) => {
      recordCommit(text)
      commitSegment(text, langs)
    },
  })
  contextTail = ''
  dbgTimer = setInterval(renderDbg, 500)
  renderDbg()

  const queue = writeQueue
  originalRenderer = createContainerRenderer(bridge, queue, 1, 'original', TOP_BOX)
  translationRenderer = createContainerRenderer(bridge, queue, 2, 'translation', MID_BOX)
  markerRenderer = createContainerRenderer(bridge, queue, 3, 'idleMark', MARKER_BOX)
  const session2 = createTranslationSession(
    session.relayUrl,
    targetLabel,
    (text, passthrough) => {
      if (!passthrough) dbg.tDone++
      maybeCutLiveView()
      transcript?.commitTranslation(text)
      // A landed translation means the translate lane recovered. The error
      // banner is only ever "last error", not a live state — when it is
      // still ours, put the healthy status back instead of letting a fixed
      // failure keep shouting.
      if (lastStatus?.kind === 'error' && lastStatus.text.startsWith('Translate error: ')) {
        runningUi?.setStatus('listening', listeningStatusText())
      }
      lastSpeechAt = Date.now() // a landed translation counts as activity too
      lastContentAt = Date.now() // and it is content — it lights the screen
      renderGlasses()
      renderPhone()
    },
    err => {
      dbg.tErr++
      dbg.tLastErr = (err as Error)?.message ?? String(err)
      renderDbg()
      runningUi?.setStatus('error', `Translate error: ${dbg.tLastErr}`)
    },
    () => contextTail,
    // Polled per request so a model switch in the running screen's dropdown
    // applies from the next segment on; the in-flight request keeps its model.
    getSelectedModel,
    text => {
      if (text) {
        maybeCutLiveView()
        lastSpeechAt = Date.now()
        lastContentAt = Date.now()
      }
      transcript?.updateCurrentTranslation(text)
      renderGlasses()
      renderPhone()
      if (speechVisible()) hideMarker()
    },
  )
  translationSession = {
    submitFinal(text, passthrough) {
      if (!passthrough) dbg.tSub++
      session2.submitFinal(text, passthrough)
    },
    dispose: () => session2.dispose(),
  }
  startIdleBlink()

  // Reads the event type out of one envelope.
  //
  // CLICK_EVENT is 0, and protobuf omits zero-value fields on the wire, so a
  // single tap arrives as an envelope whose `eventType` is `undefined`. The
  // default has to be resolved INSIDE the envelope check — checking envelope
  // existence separately from the fallback keeps events with no envelope at
  // all (e.g. audio frames) from being misread as taps.
  const eventTypeOf = (envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null => {
    if (!envelope) return null
    return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
  }

  // Keep the exit/lifecycle listener while the phone is on the home or
  // summary screen. Session gestures and audio stop with activeSession.
  if (!unsubscribe) unsubscribe = bridge.onEvenHubEvent(event => {
    const sysType = eventTypeOf(event.sysEvent)
    const textType = eventTypeOf(event.textEvent)
    if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      bridge.shutDownPageContainer(1)
      return
    }
    if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      cleanup()
      return
    }
    if (!activeSession || ending) return
    const pcm = event.audioEvent?.audioPcm
    if (pcm && !dbgPcmUrl) {
      // Room-noise learning runs in every session state — only frames well
      // below the floor update it, so speech never drags it up.
      const rms = pcmRms(pcm)
      dbg.rms = rms
      if (rms < noiseFloor * 1.5) noiseFloor += (rms - noiseFloor) * NOISE_FLOOR_ALPHA
      dbg.noiseFloor = noiseFloor

      if (stt) {
        if (wakeVerifyPending && Date.now() - wakeConnectedAt >= IDLE_VERIFY_AFTER_MS) {
          // Woken by noise: Soniox never recognized a token. Drop the socket
          // and stop listening for a cooldown so ambient sound can't loop us.
          wakeVerifyPending = false
          wakeSuppressUntil = Date.now() + IDLE_WAKE_SUPPRESS_MS
          idleDisconnectStt()
        } else {
          if (rms > noiseFloor * SEND_GATE_FACTOR) sendGateOpenUntil = Date.now() + SEND_GATE_HOLD_MS
          if (Date.now() < sendGateOpenUntil) stt.sendPcm(pcm)
          if (Date.now() - lastSpeechAt >= IDLE_DISCONNECT_AFTER_MS) idleDisconnectStt()
        }
      } else if (idleDisconnected) {
        onPcmWhileIdle(pcm, rms)
      }
    }

    // Scroll gestures carry explicit non-zero type ids and must be matched
    // before CLICK_EVENT, the value an envelope falls back to when it
    // carries no type at all.
    if (textType === OsEventTypeList.SCROLL_TOP_EVENT) {
      transcript?.scrollOlder()
      renderGlasses()
      return
    }
    if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      transcript?.scrollNewer()
      renderGlasses()
      return
    }

    if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
      toggleDisplayMode().catch(err => console.error('toggleDisplayMode failed:', err))
      return
    }
  })
}

// Writes the glasses' current view (live tail, or a scrolled-back history
// turn — transcript.ts decides which) to whichever container(s) are visible
// in the current display mode.
function renderGlasses() {
  if (!transcript) return
  if (displayMode === 'both') originalRenderer?.schedule(transcript.getGlassesOriginal())
  translationRenderer?.schedule(transcript.getGlassesTranslation())
}

// Mirrors the accumulated transcript to the phone screen as lines — the UI
// syncs each lane incrementally, independent of the glasses' scroll
// position, never auto-scrolled, free to browse.
function renderPhone() {
  if (!transcript) return
  runningUi?.setOriginalMirror(transcript.getOriginalLines(), transcript.getCurrentOriginal())
  runningUi?.setTranslationMirror(transcript.getTranslationLines(), transcript.getCurrentTranslation())
}

// Idle marker: a dedicated text strip pinned to the top of the page — the
// firmware's fixed 27px text line just fits the 28px container. Chosen over
// an image container deliberately: the device host's image channel dies
// after End (every updateImageRawData sendfails), while text writes keep
// working. Visible immediately when the session opens; blank while speech
// or translation is live; back after 5s of silence, blinking its dot. Text
// has no gray control, so "dim" after markerDimAfterMs of silence means
// small dots spreading outward — and the lanes blank at the same point,
// leaving just this one strip lit.
// renderGlasses() repaints the full transcript on the next update, so
// blanking loses nothing.
const MARKER_BLINK_MS = 900
const MARKER_FRAME_MS = MARKER_BLINK_MS / 2
// Space and · advance 5px. Three outward steps keep the center fixed,
// using only the original marker strip, then return to one small dot.
const MARKER_DIM_FRAMES = ['    ·', '   · ·', '  ·   ·', ' ·     ·']
const MARKER_RETURN_AFTER_MS = 5_000
// Silence this long blanks the lanes and switches to the small-dot
// animation — and the live view then resets on the next content, so speech
// resuming opens a fresh page (maybeCutLiveView). Per session from Settings
// → Display; the default matches the STT idle disconnect (15 s).
let markerDimAfterMs = DEFAULT_SCREEN_CLEAR_SECONDS * 1_000
const MARKER_BOX: ContainerBox = { innerWidth: 576, maxLines: 1 }

let markerTimer: ReturnType<typeof setInterval> | null = null
let markerTicks = 0
let markerAnimationStartedAt: number | null = null
let markerFrameWrite: Promise<unknown> | null = null
let speechStarted = false // cold start shows the marker before the first word
let lastSpeechAt = 0 // epoch ms of the last recognized or translated update
// Drives the screen-off (dim) decision, separate from lastSpeechAt: only
// CONTENT (stable text, commits, landed translations) counts here. Live
// drafts — what ambient noise mostly produces — must not light the screen
// back up, or the dim state could never hold in a noisy room. The STT idle
// disconnect keeps using lastSpeechAt: a socket receiving drafts is in use.
let lastContentAt = 0

function displayDim(): boolean {
  return Date.now() - lastContentAt >= markerDimAfterMs
}

// Whether any speech text is actually on the glasses right now: the lane
// tails plus the live draft (both mode shows the draft in the original
// lane; translationOnly never displays it, so only the translation lane
// counts there). The marker may only hide while this holds — hiding it
// over an empty screen is what blanked the glasses after a noise burst
// that recognized nothing.
function speechVisible(): boolean {
  if (!transcript) return false
  if (displayMode === 'both' && transcript.getGlassesOriginal()) return true
  return !!transcript.getGlassesTranslation()
}

// Silence has gone on long enough that the screen went dark — content
// resuming should open a fresh page, not drag the pre-silence text back
// with it. Cut the live view (lane tails + draft); sealed history, scroll
// and the phone mirror keep everything. Called on each content-arriving
// path BEFORE lastContentAt is refreshed, so the gap measured here is the
// real silence gap. Clearing an already-empty view is a no-op, so repeated
// calls within one silence are harmless.
function maybeCutLiveView(): void {
  if (Date.now() - lastContentAt >= markerDimAfterMs) transcript?.cutLiveView()
}

function renderMarker(dim: boolean, dotOn: boolean) {
  // A slow bridge must not queue animation ahead of pause or new speech.
  if (markerFrameWrite) return
  if (dim) markerAnimationStartedAt ??= Date.now()
  else markerAnimationStartedAt = null
  // Advance by elapsed time, not completed BLE writes. Slow writes skip
  // stale frames instead of stretching the whole animation into slow motion.
  const frame = dim ? Math.floor((Date.now() - markerAnimationStartedAt!) / MARKER_FRAME_MS) % MARKER_DIM_FRAMES.length : 0
  const dot = dim ? ` ${MARKER_DIM_FRAMES[frame]}` : dotOn ? ' ●' : ''
  markerRenderer?.schedule(`${startLanguages.join('/')} → ${startTargetCode}${dot}`)
  const write = markerRenderer?.flush()
  if (write) {
    markerFrameWrite = write
    void write.finally(() => {
      if (markerFrameWrite === write) markerFrameWrite = null
    })
  }
}

function hideMarker() {
  markerAnimationStartedAt = null
  markerRenderer?.schedule('')
}

function markerTick() {
  if (paused) {
    markerAnimationStartedAt = null
    // Static pause notice — deliberately not blinking; paused means nothing
    // is live. The lanes stay frozen on the last turn behind it.
    markerRenderer?.schedule(`pause · ${startLanguages.join('/')} → ${startTargetCode}`)
    return
  }
  if (!transcript?.isAtLive()) {
    hideMarker()
    return
  }
  // Measured from lastContentAt, not lastSpeechAt: drafts keep the STT socket
  // alive (billing) but must not keep the screen lit or un-dim the marker.
  const silentFor = Date.now() - lastContentAt
  // The return-hold only applies while text is actually on screen. Holding
  // over an empty screen is the other half of the noise blank-out — the
  // marker comes straight back when nothing was recognized.
  if (speechStarted && silentFor < MARKER_RETURN_AFTER_MS && speechVisible()) {
    hideMarker()
    markerTicks = 0
    return
  }
  markerTicks++
  const dim = displayDim()
  if (dim) {
    // Screen-off: the lanes go dark with the marker. They repaint from the
    // transcript on the next commit, translation, or history scroll — each
    // path calls renderGlasses(), which writes the full document. When
    // content eventually resumes after this, maybeCutLiveView has already
    // dropped the pre-silence text from the live view, so the lanes come
    // back showing only the new turn.
    originalRenderer?.schedule('')
    translationRenderer?.schedule('')
  }
  // Two animation ticks per blink preserve the large dot's 900ms cadence.
  renderMarker(dim, Math.floor((markerTicks - 1) * MARKER_FRAME_MS / MARKER_BLINK_MS) % 2 === 1)
}

function startIdleBlink() {
  lastSpeechAt = Date.now()
  lastContentAt = Date.now()
  speechStarted = false
  markerTicks = 0
  markerAnimationStartedAt = null
  markerTick()
  markerTimer = setInterval(markerTick, MARKER_FRAME_MS)
}

// Committing: Soniox treats continuous speech as ONE long utterance — `<end>`
// only arrives at a real pause (observed on device: 92 partials, finals:0,
// ~25s in), so waiting for `<end>` would leave a whole burst of fast speech
// uncommitted and untranslated. Instead segmenter.ts commits each sentence
// the moment it completes, working from increments — every committed
// sentence is handed over exactly once and never revisited. Text not yet
// formed into a sentence stays as the live line; `<end>` commits that tail.
// The commit is invisible: transcript.ts appends sealed text to the lanes,
// so the glasses just see the document keep scrolling.

// Same-language passthrough: a sealed segment whose dominant recognized
// language is already the target skips the model — a same-language request
// would be a no-op round trip. It is paired with itself in the translation
// lane instead (transcript.ts pairs originals and translations FIFO, so a
// skipped lane would desync every later translation). Votes are per-character
// Soniox language tags from stt.ts; untagged characters don't vote, and a
// span with no votes at all counts as "not target" — translate, the safe default.
function dominantLang(langs: CharLangs): string | undefined {
  const counts = new Map<string, number>()
  for (const lang of langs) {
    if (!lang) continue
    counts.set(lang, (counts.get(lang) ?? 0) + 1)
  }
  let best: string | undefined
  let bestN = 0
  for (const [lang, n] of counts) {
    if (n > bestN) {
      best = lang
      bestN = n
    }
  }
  return best
}

function isTargetLang(lang: string | undefined): boolean {
  if (!lang) return false
  const t = startTargetCode.toLowerCase()
  const l = lang.toLowerCase()
  return l === t || l.startsWith(`${t}-`)
}

function commitSegment(segment: string, langs: CharLangs): void {
  const trimmed = segment.trim()
  if (!trimmed) return
  maybeCutLiveView()
  lastContentAt = Date.now() // a committed sentence is content — it undims
  transcript?.commitOriginal(trimmed)
  const passthrough = isTargetLang(dominantLang(langs))
  if (passthrough) dbg.tPass++
  translationSession?.submitFinal(trimmed, passthrough)
  appendContextTail(trimmed)
  dbg.commits++
}

// TEMPORARY commit diagnostics — the recent-commit list on the phone's debug
// line. Remove with the rest of the dbg block.
function recordCommit(text: string): void {
  const line = text.trim().slice(0, 30)
  dbg.lastCommits.push(line)
  if (dbg.lastCommits.length > 4) dbg.lastCommits.shift()
  console.log('[commit]', line) // TEMPORARY diagnostics
}

// Prior committed originals — the sliding window sent as reference context on
// every translate request, so the model can resolve pronouns and ellipsis
// across segment cuts. Appended only AFTER a segment's submitFinal: requests
// for a segment must not see that segment in its own context.
const CONTEXT_MAX_CHARS = 300
// A silence this long means the conversation has moved on — pause, idle gap —
// so the window's referents are stale. Dropped at the next append, the only
// moment the window is actually read, which covers every gap source at once.
// The topic check below is the primary reset trigger; this is the fallback
// for when that check never answers.
const CONTEXT_STALE_MS = 2 * 60_000
// The topic check is a plain chat request answered with one word; a hung one
// must not sit around forever. Give up silently — a missed check just means
// one missed topic reset.
const TOPIC_CHECK_TIMEOUT_MS = 8_000
let contextTail = ''
let contextTailAt = 0
// Set per session; the topic check needs the relay just like translation does.
let activeRelayUrl = ''

function appendContextTail(sealed: string): void {
  const now = Date.now()
  if (contextTail && now - contextTailAt > CONTEXT_STALE_MS) contextTail = ''
  contextTailAt = now
  const prev = contextTail
  const next = contextTail ? `${contextTail}\n${sealed}` : sealed
  if (next.length <= CONTEXT_MAX_CHARS) {
    contextTail = next
  } else {
    // Over the budget: drop from the front, snapping forward to the next whole
    // segment so the window never starts mid-segment.
    const nl = next.indexOf('\n', next.length - CONTEXT_MAX_CHARS)
    contextTail = nl >= 0 ? next.slice(nl + 1) : next.slice(next.length - CONTEXT_MAX_CHARS)
  }
  // A non-empty prev means this segment continues something — worth checking
  // whether "something" is still the same topic. Fire-and-forget: the answer
  // never blocks this segment's translation, it only shapes the window the
  // NEXT segment sees.
  if (prev) void checkTopicChange(prev, sealed)
}

// Asks the selected model (via the relay's /topic) whether `next` continues
// `prev`'s subject. On "new", everything before `next` in the window is
// dropped and `next` becomes the new window head — its own segment stays, so
// the follow-up sentence ("他坐高铁去") still resolves against it. Any
// failure — relay down, model unconfigured, timeout, a non-"new" answer —
// is treated as "same": at worst one missed reset, never a wrongful wipe.
async function checkTopicChange(prev: string, next: string): Promise<void> {
  const gen = sttGen
  const model = getSelectedModel()
  if (!activeRelayUrl || !model?.url || !model.name || !model.key) return
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TOPIC_CHECK_TIMEOUT_MS)
  try {
    const res = await fetch(`${activeRelayUrl}/topic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prev, next, model }),
      signal: abort.signal,
    })
    if (!res.ok) return
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    if (gen !== sttGen || !activeSession) return
    const verdict = (data.choices?.[0]?.message?.content ?? '').trim().toLowerCase()
    if (!verdict.includes('new')) return // "same", or a garbled answer — keep the window
    const parts = contextTail.split('\n')
    const idx = parts.lastIndexOf(next)
    // idx <= 0: `next` is already the window head, or has been pushed out by
    // later segments — either way the old subject is already gone; nothing to do.
    if (idx > 0) contextTail = parts.slice(idx).join('\n')
  } catch {
    // Timeout or network failure: keep the window as-is.
  } finally {
    clearTimeout(timer)
  }
}

async function toggleDisplayMode() {
  if (!transcript) return
  const nextMode: DisplayMode = displayMode === 'both' ? 'translationOnly' : 'both'

  if (nextMode === 'translationOnly') {
    translationRenderer?.setBox(FULL_BOX)
    const translation = translationContainerProps('translationOnly')
    // rebuild content is capped by the firmware (~1KB) — fit to the box
    // exactly like the renderer does instead of passing the whole log.
    translation.content =
      fitTail(transcript.getGlassesTranslation() || ' ', FULL_BOX.innerWidth, FULL_BOX.maxLines) || ' '
    const ok = await bridgeRef?.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        textObject: [translation, idleMarkerProps()],
      }),
    )
    if (!ok) {
      console.error('rebuildPageContainer failed switching to translationOnly')
      return
    }
    // The rebuild removed container 1 — a debounced original write left over
    // from before the switch would fail with "container 1 not found".
    originalRenderer?.cancel()
  } else {
    originalRenderer?.setBox(TOP_BOX)
    translationRenderer?.setBox(MID_BOX)
    const original = originalContainerProps()
    original.content = fitTail(transcript.getGlassesOriginal() || ' ', TOP_BOX.innerWidth, TOP_BOX.maxLines) || ' '
    const translation = translationContainerProps('both')
    translation.content =
      fitTail(transcript.getGlassesTranslation() || ' ', MID_BOX.innerWidth, MID_BOX.maxLines) || ' '
    const ok = await bridgeRef?.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 3,
        textObject: [original, translation, idleMarkerProps()],
      }),
    )
    if (!ok) {
      console.error('rebuildPageContainer failed switching to both')
      return
    }
  }

  displayMode = nextMode
  // The rebuild recreated the marker container blank — forget the last
  // written text so the next tick repaints the strip.
  markerRenderer?.reset()
  // renderGlasses() will re-fit the just-written content on the next real
  // text change; the geometry itself (and this immediate frame) is already
  // correct via the rebuild call above.
  runningUi?.setStatus('listening', listeningStatusText())
}

function pauseSession() {
  if (paused) return
  paused = true
  sttGen++ // a pre-pause wake must not replace the manually resumed stream
  bridgeRef?.audioControl(false)
  // Soniox bills connection time, so pausing actually disconnects — silence
  // is never billed. The mid-utterance tail was never committed anyway; drop it.
  stt?.close()
  stt = null
  // Pause overrides idle-disconnect entirely: the mic goes off, so nothing
  // would ever wake the stream — resume owns reopening.
  idleDisconnected = false
  waking = false
  wakeVerifyPending = false
  clearWakeBuffer()
  runningUi?.setPaused(true)
  runningUi?.setStatus('listening', t('Paused · glasses frozen on the last turn'))
}

async function resumeSession() {
  if (!paused || !activeSession) return
  const session = activeSession
  const gen = sttGen
  if (session) {
    try {
      const client = await openStt(startLanguages, session)
      if (gen !== sttGen || activeSession !== session || cleanedUp) {
        client.close()
        return
      }
      stt = client
    } catch (err) {
      if (gen !== sttGen || activeSession !== session || cleanedUp) return
      runningUi?.setStatus('error', `STT error: ${(err as Error)?.message ?? err}`)
      return
    }
    idleDisconnected = false
    wakeVerifyPending = false // manual resume — no noise adjudication needed
  }
  paused = false
  bridgeRef?.audioControl(true)
  runningUi?.setPaused(false)
  runningUi?.setStatus('listening', listeningStatusText())
}

// Closes the STT connection and translation session — shared by cleanup()
// (app is exiting) and endSession() (returning to the settings screen while
// staying open). audioControl is intentionally NOT touched here: cleanup()
// and endSession() each want it off, but for different reasons/timings, so
// each sets it itself.
function teardownSession() {
  activeSession = null
  sttGen++ // invalidate any pending reconnect timer
  if (markerTimer !== null) {
    clearInterval(markerTimer)
    markerTimer = null
  }
  if (dbgTimer !== null) {
    clearInterval(dbgTimer)
    dbgTimer = null
  }
  stt?.close()
  stt = null
  idleDisconnected = false
  waking = false
  wakeVerifyPending = false
  clearWakeBuffer()
  translationSession?.dispose()
  translationSession = null
  originalRenderer?.cancel()
  translationRenderer?.cancel()
  markerRenderer?.cancel()
  originalRenderer = null
  translationRenderer = null
  markerRenderer = null
  markerFrameWrite = null
  runningUi = null
  transcript = null
  segmenter = null
}

// Save the raw snapshot before asking the model. Stay on the progress screen
// until the summary is saved (or fails), then return to the in-app home page.
async function endSession() {
  if (ending || !activeSession) return
  ending = true
  const session = activeSession
  const model = getSelectedModel() ?? session.model
  const original = transcript?.getFullOriginal().trim() ?? ''
  const translation = transcript?.getFullTranslation().trim() ?? ''
  const shouldSummarize = session.summaryEnabled === true && !!original
  ui.showEnding(shouldSummarize)
  teardownSession()
  let message = ''
  try {
    // Drain already queued writes before blanking the retained glasses page.
    // It stays alive so a later Start can rebuild it without exiting the app.
    try {
      await bridgeRef?.audioControl(false)
      await writeQueue.current
      await bridgeRef?.rebuildPageContainer(new RebuildPageContainer({
        containerTotalNum: 3,
        textObject: [originalContainerProps(), translationContainerProps('both'), idleMarkerProps()],
      }))
    } catch (err) {
      console.warn('clearing glasses after End failed:', err)
    }
    if (original || translation) {
      const record: SessionRecord = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        savedAt: Date.now(),
        sourceLangs: startLanguages,
        targetLang: startTargetLang,
        original,
        translation,
      }
      await addRecord(record)
      if (shouldSummarize && !cleanedUp) {
        summaryAbort = new AbortController()
        try {
          const summary = await generateSummary(original, record.targetLang, session.relayUrl, model, summaryAbort.signal)
          if (!cleanedUp) await saveRecordSummary(record.id, summary)
        } catch (err) {
          console.error('summary failed:', err)
          message = t('Summary failed. Transcript saved; retry from History.')
        } finally {
          summaryAbort = null
        }
      }
    }
  } catch (err) {
    console.error('archiving session failed:', err)
    message = t('Could not save this session.')
  } finally {
    ending = false
    if (!cleanedUp) ui.showHome(message)
  }
}

function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  summaryAbort?.abort()
  bridgeRef?.audioControl(false)
  teardownSession()
  unsubscribe?.()
  unsubscribe = null
}

window.addEventListener('beforeunload', cleanup)
