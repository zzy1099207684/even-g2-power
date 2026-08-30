import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { startFluxStream, type SttClient } from './asr/stt'
import { createTranslationSession, type TranslationSession } from './translate'
import { createTranscript, type Transcript } from './transcript'
import { addRecord } from './history'
import { mountUi, type RunningUiHandle } from './ui'
import { createWriteQueue, createContainerRenderer, fitTail, type ContainerBox, type ContainerRenderer } from './render'

const RELAY_URL = import.meta.env.VITE_RELAY_URL as string

type DisplayMode = 'both' | 'translationOnly'

const BOTH_BOX: ContainerBox = { innerWidth: 568, maxLines: 5 }
const FULL_BOX: ContainerBox = { innerWidth: 568, maxLines: 10 }

function originalContainerProps(): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 144,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: 1,
    containerName: 'original',
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
        yPosition: 0,
        width: 576,
        height: 288,
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
let originalRenderer: ContainerRenderer | null = null
let translationRenderer: ContainerRenderer | null = null
let runningUi: RunningUiHandle | null = null
let unsubscribe: (() => void) | null = null
let displayMode: DisplayMode = 'both'
let paused = false
let cleanedUp = false
// Language selection of the running session — kept for archiving on End.
let startLanguages: string[] = []
let startTargetLang = 'Chinese (Simplified)'

const ui = mountUi({
  onStart: handleStart,
  onPause: pauseSession,
  onResume: resumeSession,
  onEnd: endSession,
})

async function handleStart(languages: string[], targetLang: string) {
  if (!RELAY_URL) {
    ui.showStartError('VITE_RELAY_URL not set — copy .env.example to .env.local')
    return
  }

  startLanguages = languages
  startTargetLang = targetLang
  ui.showConnecting()

  const bridge = await bridgePromise

  try {
    stt = await startFluxStream({
      relayUrl: RELAY_URL,
      languageHints: languages,
      onPartial: handlePartialTranscript,
      onFinal: handleFinalTranscript,
      onError: err => runningUi?.setStatus('error', `STT error: ${(err as Error)?.message ?? err}`),
    })
  } catch (err) {
    ui.showStartError((err as Error)?.message ?? 'Failed to start speech recognition')
    return
  }

  // First launch creates the page; `invalid` means the page already exists
  // (End kept it open on the glasses — shutDownPageContainer would kill the
  // whole app), so rebuild it back to the initial layout instead.
  const created = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({
      containerTotalNum: 2,
      textObject: [originalContainerProps(), translationContainerProps('both')],
    }),
  )
  if (created !== 0) {
    const rebuilt = await bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 2,
        textObject: [originalContainerProps(), translationContainerProps('both')],
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
  sealIndex = 0

  const queue = createWriteQueue()
  originalRenderer = createContainerRenderer(bridge, queue, 1, 'original', BOTH_BOX)
  translationRenderer = createContainerRenderer(bridge, queue, 2, 'translation', BOTH_BOX)
  translationSession = createTranslationSession(
    RELAY_URL,
    targetLang,
    text => {
      transcript?.updateCurrentTranslation(text)
      renderGlasses()
      renderPhone()
    },
    text => {
      transcript?.commitTranslation(text)
      renderGlasses()
      renderPhone()
    },
    err => runningUi?.setStatus('error', `Translate error: ${(err as Error)?.message ?? err}`),
  )

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
    if (pcm) stt?.sendPcm(pcm)

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

// Mirrors the full accumulated transcript to the phone screen — independent
// of the glasses' scroll position, never auto-scrolled, free to browse.
function renderPhone() {
  if (!transcript) return
  runningUi?.setOriginalMirror(transcript.getFullOriginal())
  runningUi?.setTranslationMirror(transcript.getFullTranslation())
}

// Forced sealing: turn-taking is Flux's job and only happens on pauses, so a
// speaker reading aloud never triggers one and the current turn would grow
// unboundedly — every partial would retranslate the whole thing (latency
// grows, output starts repeating) and per-frame text fitting gets heavier
// until the page chokes. Instead, once the unsealed tail passes SEAL_LIMIT
// chars we seal everything up to the best nearby break as if it were final;
// only the short remainder keeps being retranslated. The seal is invisible:
// transcript.ts appends sealed text to the continuous lanes, so the glasses
// just see the document keep scrolling.
const SEAL_LIMIT = 240
let sealIndex = 0 // chars of the current Flux turn already sealed off

// Finds the seal cut point in text[from, limit): prefer the last
// sentence-ending punctuation, then any clause punctuation, then a space;
// the punctuation itself stays with the sealed head. Returns an absolute
// index; `limit` when the window has no break at all (hard cut).
function findSealIndex(text: string, from: number, limit: number): number {
  const window = text.slice(from, limit)
  let best = -1
  for (const ch of ['.', '!', '?', '…']) {
    const i = window.lastIndexOf(ch)
    if (i > best) best = i
  }
  if (best < 0) {
    for (const ch of [',', ';', ':', '，', '；', '：', '、']) {
      const i = window.lastIndexOf(ch)
      if (i > best) best = i
    }
  }
  if (best < 0) best = window.lastIndexOf(' ')
  if (best < 0) return limit
  return from + best + 1
}

// Fires continuously while the current utterance is still being recognized
// (Flux's `Update` messages). Keeps the original caption live and lets
// translate.ts's Local-Agreement logic start translating before the speaker
// pauses, instead of waiting for EndOfTurn.
function handlePartialTranscript(text: string) {
  // A new turn's first Updates carry an empty transcript before any words
  // are recognized — skip them so the previous utterance's text stays on
  // screen through a pause instead of being blanked.
  if (!text) return

  let active = text.slice(sealIndex)
  if (active.length >= SEAL_LIMIT) {
    const cut = findSealIndex(text, sealIndex, sealIndex + SEAL_LIMIT)
    const sealed = text.slice(sealIndex, cut).trim()
    sealIndex = cut
    if (sealed) {
      transcript?.commitOriginal(sealed)
      translationSession?.submitFinal(sealed)
    }
    active = text.slice(sealIndex)
  }

  const activeText = active.trimStart()
  transcript?.updateCurrentOriginal(activeText)
  renderGlasses()
  renderPhone()
  translationSession?.submitPartial(activeText)
}

// Fires once the utterance is judged finished (Flux's `EndOfTurn`). Whatever
// the forced sealing left unsealed is sealed now; the next Flux turn starts
// counting from zero.
function handleFinalTranscript(text: string) {
  const active = text.slice(sealIndex).trim()
  sealIndex = 0
  if (!active) return
  transcript?.commitOriginal(active)
  renderGlasses()
  renderPhone()
  translationSession?.submitFinal(active)
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
      new RebuildPageContainer({ containerTotalNum: 1, textObject: [translation] }),
    )
    if (!ok) {
      console.error('rebuildPageContainer failed switching to translationOnly')
      return
    }
    // The rebuild removed container 1 — a debounced original write left over
    // from before the switch would fail with "container 1 not found".
    originalRenderer?.cancel()
  } else {
    originalRenderer?.setBox(BOTH_BOX)
    translationRenderer?.setBox(BOTH_BOX)
    const original = originalContainerProps()
    original.content = fitTail(transcript.getGlassesOriginal() || ' ', BOTH_BOX.innerWidth, BOTH_BOX.maxLines) || ' '
    const translation = translationContainerProps('both')
    translation.content =
      fitTail(transcript.getGlassesTranslation() || ' ', BOTH_BOX.innerWidth, BOTH_BOX.maxLines) || ' '
    const ok = await bridgeRef?.rebuildPageContainer(
      new RebuildPageContainer({ containerTotalNum: 2, textObject: [original, translation] }),
    )
    if (!ok) {
      console.error('rebuildPageContainer failed switching to both')
      return
    }
  }

  displayMode = nextMode
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
  runningUi?.setPaused(true)
  runningUi?.setStatus('listening', 'Paused · glasses frozen on the last turn')
}

function resumeSession() {
  if (!paused) return
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
  stt?.close()
  stt = null
  translationSession?.dispose()
  translationSession = null
  unsubscribe?.()
  unsubscribe = null
}

// "End" — archive this session, stop it, and stay in the app at the settings
// screen. Distinct from double-tap exit, which leaves the app entirely; that
// hardware gesture is untouched by this.
async function endSession() {
  bridgeRef?.audioControl(false)
  const original = transcript?.getFullOriginal().trim()
  const translation = transcript?.getFullTranslation().trim()
  if (original && translation) {
    await addRecord({
      id: crypto.randomUUID(),
      savedAt: Date.now(),
      sourceLangs: startLanguages,
      targetLang: startTargetLang,
      original,
      translation,
    })
  }
  teardownSession()
  ui.showSettings()
}

function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  bridgeRef?.audioControl(false)
  teardownSession()
}

window.addEventListener('beforeunload', cleanup)
