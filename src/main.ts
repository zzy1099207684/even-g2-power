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
import { addRecord } from './history'
import { loadUiConfig, type SessionConfig, type UiConfig } from './config'
import { mountUi, getSelectedModel, type RunningUiHandle } from './ui'
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
let unsubscribe: (() => void) | null = null
let displayMode: DisplayMode = 'both'
let paused = false
let cleanedUp = false

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
  bytes: 0,
  lastLen: 0,
  lastFinalLen: 0,
  tSub: 0,
  tDone: 0,
  tPass: 0,
  tErr: 0,
  tLastErr: '',
  lastCommits: [] as string[],
}
let dbgTimer: ReturnType<typeof setInterval> | null = null

function renderDbg() {
  const err = dbg.tLastErr ? ` lastTErr:${dbg.tLastErr.slice(0, 60)}` : ''
  const last = dbg.lastCommits.length ? ` · L ${dbg.lastCommits.join(' | ')}` : ''
  runningUi?.setDebug(
    `STT p:${dbg.partials} f:${dbg.finals} c:${dbg.commits} e:${dbg.errors} · ` +
      `TR sub:${dbg.tSub} done:${dbg.tDone} pass:${dbg.tPass} err:${dbg.tErr}${err}${last}`,
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

// Speech is flowing (a stable delta, a fresh draft, or the utterance tail
// just landed): keep the idle marker quiet and mirror the segmenter's
// not-yet-committed workspace as the live line.
function afterSpeechEvent(): void {
  speechStarted = true
  lastSpeechAt = Date.now()
  hideMarker() // speech is back — hide the marker immediately
  transcript?.updateCurrentOriginal(segmenter?.getPendingText() ?? '')
  renderGlasses()
  renderPhone()
}

async function openStt(languages: string[], session: SessionConfig): Promise<SttClient> {
  const client = await startSonioxStream({
    apiKey: session.sonioxKey,
    languageHints: languages,
    onStable: (text, langs) => {
      sttRetries = 0
      dbg.partials++
      dbg.lastLen = text.length
      segmenter?.addStable(text, langs)
      afterSpeechEvent()
    },
    onLive: (live, langs) => {
      sttRetries = 0
      // A response with no stable delta and no draft carries nothing new —
      // skip it so the previous utterance's line stays on screen through a
      // pause instead of being blanked.
      if (!live && !segmenter?.getPendingText()) return
      dbg.lastLen = live.length
      segmenter?.setLive(live, langs)
      afterSpeechEvent()
    },
    onEnd: (tail, langs) => {
      sttRetries = 0
      dbg.finals++
      dbg.lastFinalLen = tail.length
      segmenter?.end(tail, langs)
      afterSpeechEvent()
    },
    onError: err => {
      dbg.errors++
      renderDbg()
      runningUi?.setStatus('error', `STT error: ${(err as Error)?.message ?? err}`)
      scheduleSttReopen()
    },
  })
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
  if (!activeSession || paused || cleanedUp) return
  if (sttRetries >= 3) return
  sttRetries++
  const gen = ++sttGen
  setTimeout(async () => {
    if (gen !== sttGen || paused || cleanedUp || !activeSession) return
    try {
      stt?.close()
    } catch {
      // Socket already gone — reopening is all that matters.
    }
    try {
      stt = await openStt(startLanguages, activeSession)
      runningUi?.setStatus(
        'listening',
        displayMode === 'both'
          ? 'Microphone live · glasses: original + translation'
          : 'Microphone live · glasses: translation only',
      )
    } catch (err) {
      runningUi?.setStatus('error', `STT error: ${(err as Error)?.message ?? err}`)
    }
  }, 1500)
}

async function handleStart(languages: string[], targetCode: string, targetLabel: string, session: SessionConfig) {
  startLanguages = languages
  startTargetCode = targetCode.split('-')[0] // 'zh-Hans' → 'zh' for the marker
  startTargetLang = targetLabel
  ui.showConnecting()

  const bridge = await bridgePromise

  try {
    stt = await openStt(languages, session)
  } catch (err) {
    ui.showStartError((err as Error)?.message ?? 'Failed to start speech recognition')
    return
  }
  activeSession = session
  if (dbgPcmUrl) void startPcmFeeder(stt)

  // First launch creates the page; `invalid` means the page already exists
  // (the webview reloaded while the glasses page persisted), so rebuild it
  // back to the initial layout. Rebuild is mandatory here: writes to a kept
  // page silently no-op, and the rebuild is what re-arms the containers
  // (text writes verified working on device across End→Start).
  const created = await bridge.createStartUpPageContainer(
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
      ui.showStartError(`createStartUpPageContainer failed: ${created}`)
      return
    }
  }
  bridgeRef = bridge
  displayMode = 'both'
  paused = false

  await bridge.audioControl(true)

  runningUi = ui.showRunning()
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
    text => {
      dbg.tDone++
      transcript?.commitTranslation(text)
      lastSpeechAt = Date.now() // a landed translation counts as activity too
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
  )
  translationSession = {
    submitFinal(text) {
      dbg.tSub++
      session2.submitFinal(text)
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

  unsubscribe = bridge.onEvenHubEvent(event => {
    const pcm = event.audioEvent?.audioPcm
    if (pcm && !dbgPcmUrl) stt?.sendPcm(pcm)

    const sysType = eventTypeOf(event.sysEvent)
    const textType = eventTypeOf(event.textEvent)

    if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      bridge.shutDownPageContainer(1)
      return
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

    if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      cleanup()
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
  runningUi?.setTranslationMirror(transcript.getTranslationLines())
}

// Idle marker: a dedicated text strip pinned to the top of the page — the
// firmware's fixed 27px text line just fits the 28px container. Chosen over
// an image container deliberately: the device host's image channel dies
// after End (every updateImageRawData sendfails), while text writes keep
// working. Visible immediately when the session opens; blank while speech
// or translation is live; back after 5s of silence, blinking its dot. Text
// has no gray control, so "dim" after 60s of silence means a small dot on
// a 1-in-4 duty cycle — fewer lit pixels, less power.
const MARKER_BLINK_MS = 900
const MARKER_RETURN_AFTER_MS = 5_000
const MARKER_DIM_AFTER_MS = 60_000
const MARKER_BOX: ContainerBox = { innerWidth: 576, maxLines: 1 }

let markerTimer: ReturnType<typeof setInterval> | null = null
let markerTicks = 0
let speechStarted = false // cold start shows the marker before the first word
let lastSpeechAt = 0 // epoch ms of the last recognized or translated update

function renderMarker(dim: boolean, dotOn: boolean) {
  const dot = !dotOn ? '' : dim ? ' ·' : ' ●'
  markerRenderer?.schedule(`${startLanguages.join('/')} → ${startTargetCode}${dot}`)
}

function hideMarker() {
  markerRenderer?.schedule('')
}

function markerTick() {
  if (paused) {
    // Static pause notice — deliberately not blinking; paused means nothing
    // is live. The lanes stay frozen on the last turn behind it.
    markerRenderer?.schedule(`pause · ${startLanguages.join('/')} → ${startTargetCode}`)
    return
  }
  if (!transcript?.isAtLive()) {
    hideMarker()
    return
  }
  const silentFor = Date.now() - lastSpeechAt
  if (speechStarted && silentFor < MARKER_RETURN_AFTER_MS) {
    hideMarker()
    markerTicks = 0
    return
  }
  markerTicks++
  const dim = silentFor >= MARKER_DIM_AFTER_MS
  renderMarker(dim, markerTicks % (dim ? 4 : 2) === 0)
}

function startIdleBlink() {
  lastSpeechAt = Date.now()
  speechStarted = false
  markerTicks = 0
  markerTick()
  markerTimer = setInterval(markerTick, MARKER_BLINK_MS)
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
  transcript?.commitOriginal(trimmed)
  if (isTargetLang(dominantLang(langs))) {
    transcript?.commitTranslation(trimmed)
    dbg.tPass++
  } else {
    translationSession?.submitFinal(trimmed)
  }
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
const CONTEXT_MAX_CHARS = 500
let contextTail = ''

function appendContextTail(sealed: string): void {
  const next = contextTail ? `${contextTail}\n${sealed}` : sealed
  if (next.length <= CONTEXT_MAX_CHARS) {
    contextTail = next
    return
  }
  // Over the budget: drop from the front, snapping forward to the next whole
  // segment so the window never starts mid-segment.
  const nl = next.indexOf('\n', next.length - CONTEXT_MAX_CHARS)
  contextTail = nl >= 0 ? next.slice(nl + 1) : next.slice(next.length - CONTEXT_MAX_CHARS)
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
  runningUi?.setStatus(
    'listening',
    displayMode === 'both' ? 'Microphone live · glasses: original + translation' : 'Microphone live · glasses: translation only',
  )
}

function pauseSession() {
  if (paused) return
  paused = true
  bridgeRef?.audioControl(false)
  // Soniox bills connection time, so pausing actually disconnects — silence
  // is never billed. The mid-utterance tail was never committed anyway; drop it.
  stt?.close()
  stt = null
  runningUi?.setPaused(true)
  runningUi?.setStatus('listening', 'Paused · glasses frozen on the last turn')
}

async function resumeSession() {
  if (!paused) return
  if (activeSession) {
    try {
      stt = await openStt(startLanguages, activeSession)
    } catch (err) {
      runningUi?.setStatus('error', `STT error: ${(err as Error)?.message ?? err}`)
      return
    }
  }
  paused = false
  bridgeRef?.audioControl(true)
  runningUi?.setPaused(false)
  runningUi?.setStatus(
    'listening',
    displayMode === 'both' ? 'Microphone live · glasses: original + translation' : 'Microphone live · glasses: translation only',
  )
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
  translationSession?.dispose()
  translationSession = null
  unsubscribe?.()
  unsubscribe = null
}

// "End" — archive this session, then close the whole plugin (same mechanism
// as double-tap exit, minus the confirmation). History is persisted first, so
// relaunching keeps everything. End exits instead of returning to the
// settings screen because the device host stops honoring container writes to
// a page kept open across sessions — a full exit is the only clean stop, and
// it also frees the glasses display immediately.
async function endSession() {
  bridgeRef?.audioControl(false)
  const original = transcript?.getFullOriginal().trim()
  const translation = transcript?.getFullTranslation().trim()
  if (original && translation) {
    try {
      await addRecord({
        // crypto.randomUUID needs a secure context and is absent when the
        // device loads the app over plain LAN http — derive the id instead.
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        savedAt: Date.now(),
        sourceLangs: startLanguages,
        targetLang: startTargetLang,
        original,
        translation,
      })
    } catch (err) {
      // The user asked to exit — log and go; the record is lost this once.
      console.error('archiving session failed:', err)
    }
  }
  teardownSession()
  const exited = await bridgeRef?.shutDownPageContainer(0)
  if (!exited) {
    // Shutdown refused — fall back to the in-app settings screen.
    ui.showStartError('Exit failed — double-tap the glasses to exit')
  }
}

function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  bridgeRef?.audioControl(false)
  teardownSession()
}

window.addEventListener('beforeunload', cleanup)
