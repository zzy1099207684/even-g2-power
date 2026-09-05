// Phone-side companion UI: settings screen (session history, language pickers,
// Start), the running mirror of what's on the glasses, and a per-record
// detail view. Pure DOM rendering — no SDK/bridge calls here; persistence goes
// through the async record helpers in history.ts.

import { listRecords, getRecord, deleteRecord, saveRecordSummary, type SessionRecord } from './history'
import { generateSummary } from './summary'
import {
  DEFAULT_HISTORY_MAX_RECORDS,
  DEFAULT_HISTORY_RETENTION_DAYS,
  DEFAULT_SCREEN_CLEAR_SECONDS,
  MIN_SCREEN_CLEAR_SECONDS,
  saveUiConfig,
  type ModelProfile,
  type SessionConfig,
  type UiConfig,
} from './config'
import { getUiLang, setUiLang, t, tf } from './i18n'

// Bound to Soniox stt-rt-v5 (60+ languages with per-token language
// identification, including Chinese). `label` is the English display name (also the archived-record
// form), `zh` its Chinese counterpart picked by the UI-language toggle.
const ASR_LANGUAGES = [
  { code: 'zh', label: 'Chinese', zh: '中文' },
  { code: 'en', label: 'English', zh: '英语' },
  { code: 'es', label: 'Spanish', zh: '西班牙语' },
  { code: 'fr', label: 'French', zh: '法语' },
  { code: 'de', label: 'German', zh: '德语' },
  { code: 'hi', label: 'Hindi', zh: '印地语' },
  { code: 'ru', label: 'Russian', zh: '俄语' },
  { code: 'pt', label: 'Portuguese', zh: '葡萄牙语' },
  { code: 'ja', label: 'Japanese', zh: '日语' },
  { code: 'it', label: 'Italian', zh: '意大利语' },
  { code: 'nl', label: 'Dutch', zh: '荷兰语' },
]

// Any language DeepSeek writes well is a valid target; the ASR list above is
// the one bound to the Soniox model.
const TARGET_LANGUAGES = [
  { code: 'zh-Hans', label: 'Chinese (Simplified)', zh: '简体中文' },
  { code: 'zh-Hant', label: 'Chinese (Traditional)', zh: '繁体中文' },
  { code: 'en', label: 'English', zh: '英语' },
  { code: 'ja', label: 'Japanese', zh: '日语' },
  { code: 'ko', label: 'Korean', zh: '韩语' },
  { code: 'de', label: 'German', zh: '德语' },
  { code: 'fr', label: 'French', zh: '法语' },
  { code: 'es', label: 'Spanish', zh: '西班牙语' },
  { code: 'ru', label: 'Russian', zh: '俄语' },
  { code: 'pt', label: 'Portuguese', zh: '葡萄牙语' },
  { code: 'it', label: 'Italian', zh: '意大利语' },
  { code: 'nl', label: 'Dutch', zh: '荷兰语' },
  { code: 'hi', label: 'Hindi', zh: '印地语' },
]

// Display name for a language entry, in the companion UI's language.
function langLabel(l: { label: string; zh: string }): string {
  return getUiLang() === 'zh' ? l.zh : l.label
}

// Selection survives leaving and re-entering the settings screen (record
// detail, running session). The service configuration (relay, Soniox key,
// model profiles) is loaded from storage at mount and edited through the
// Settings modal.
let selectedSources = new Set<string>(['en', 'de'])
let selectedTarget = TARGET_LANGUAGES[0].code
let relayUrl = ''
let sonioxKey = ''
let models: ModelProfile[] = []
let selectedModelId = ''
// Session-archive retention (Settings → History). Defaults until a saved or
// restored config says otherwise.
let historyRetentionDays = DEFAULT_HISTORY_RETENTION_DAYS
let historyMaxRecords = DEFAULT_HISTORY_MAX_RECORDS
// Seconds of content silence before the glasses' screen clears to a fresh
// page (Settings → Display). Defaults until a saved or restored config says
// otherwise.
let screenClearSeconds = DEFAULT_SCREEN_CLEAR_SECONDS
let summaryEnabled = false

type StatusKind = 'listening' | 'error'

export interface RunningUiHandle {
  setStatus(kind: StatusKind, text: string): void
  /** Sealed original lines plus the live (still-revising) line — synced incrementally. */
  setOriginalMirror(sealed: readonly string[], current: string): void
  /** Sealed translation lines plus the currently streaming sentence. */
  setTranslationMirror(sealed: readonly string[], current: string): void
  setPaused(paused: boolean): void
  /** TEMPORARY: STT pipeline diagnostics, remove after debugging. */
  setDebug(text: string): void
}

export interface UiHandle {
  showConnecting(): void
  showEnding(summarizing: boolean): void
  showHome(message?: string): void
  showStartError(message: string): void
  showRunning(): RunningUiHandle
  /** Apply the restored last-used selection; re-renders only if on settings. */
  applyConfig(config: UiConfig): void
}

export interface UiCallbacks {
  onStart(sources: string[], targetCode: string, targetLabel: string, session: SessionConfig): void
  onPause(): void
  onResume(): void
  onEnd(): void
}

/** The profile the dropdowns currently point at — the model translation uses. */
export function getSelectedModel(): ModelProfile | null {
  return models.find(m => m.id === selectedModelId) ?? null
}

// iOS keyboards strip the scheme as fast as users type it ("host.tld" without
// https:// fails natively with "The string did not match the expected
// pattern"), so scheme-less URLs get https:// assumed everywhere the value is
// read. An explicit scheme the user typed is preserved.
function withHttps(url: string): string {
  const trimmed = url.trim()
  if (!trimmed || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

// Compact "EN/DE → ZH" summary for the Start-screen bar and sheet header.
function langBarText(): string {
  const src = ASR_LANGUAGES.filter(l => selectedSources.has(l.code)).map(l => l.code.toUpperCase())
  const tgt = selectedTarget.split('-')[0].toUpperCase()
  return `${src.length ? src.join('/') : '···'} → ${tgt}`
}

// Shared by the page-level Start button and the sheet's Start button.
function beginSession(callbacks: UiCallbacks, errorEl: HTMLParagraphElement): void {
  const sources = [...selectedSources]
  if (sources.length < 1 || sources.length > 3) {
    errorEl.textContent = t('Pick 1 to 3 languages to listen for.')
    return
  }
  // Everything the relay and session need is user-provided — nothing is
  // baked in, so refuse to start until Settings has it all.
  const missing: string[] = []
  if (!relayUrl.trim()) missing.push(t('relay URL'))
  if (!sonioxKey.trim()) missing.push(t('Soniox key'))
  if (!models.length) missing.push(t('a model'))
  else if (!getSelectedModel()) missing.push(t('a selected model'))
  if (missing.length) {
    errorEl.textContent = `${t('Configure in Settings')}: ${missing.join(', ')}.`
    return
  }
  errorEl.textContent = ''
  // Remember this selection for the next open.
  const target = TARGET_LANGUAGES.find(l => l.code === selectedTarget) ?? TARGET_LANGUAGES[0]
  const model = getSelectedModel()!
  void saveUiConfig(fullConfig())
  callbacks.onStart(sources, target.code, target.label, {
    relayUrl: relayUrl.trim().replace(/\/+$/, ''),
    sonioxKey: sonioxKey.trim(),
    model,
    screenClearSeconds,
    summaryEnabled,
  })
}

function fullConfig(): UiConfig {
  return {
    sources: [...selectedSources],
    target: selectedTarget,
    relayUrl,
    sonioxKey,
    models,
    activeModelId: selectedModelId,
    historyRetentionDays,
    historyMaxRecords,
    screenClearSeconds,
    summaryEnabled,
    uiLang: getUiLang(),
  }
}

function isProfile(value: unknown): value is ModelProfile {
  const m = value as ModelProfile
  return (
    !!m &&
    typeof m.id === 'string' &&
    typeof m.label === 'string' &&
    typeof m.name === 'string' &&
    typeof m.url === 'string' &&
    typeof m.key === 'string'
  )
}

// Well-known provider templates for the model cards — a convenience that
// pre-fills name/URL/extra params and suggests model IDs. `extra` carries the
// provider's thinking-off parameter per its official docs (identical shape
// for DeepSeek and GLM; GLM-5.3+ forces thinking and rejects `disabled`).
// Nothing here is user-specific: every field stays editable, "Custom" means
// fully manual, and only the resolved fields (plus the optional extra params)
// are ever persisted.
const MODEL_PRESETS = [
  { key: 'custom', label: 'Custom', name: '', url: '', extra: '', ids: [] as string[] },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    name: 'DeepSeek',
    url: 'https://api.deepseek.com/chat/completions',
    extra: '{"thinking":{"type":"disabled"}}',
    ids: ['deepseek-v4-flash-vision-exp', 'deepseek-chat', 'deepseek-reasoner'],
  },
  {
    key: 'glm',
    label: 'GLM',
    name: 'GLM',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    extra: '{"thinking":{"type":"disabled"}}',
    ids: ['glm-4-flash', 'glm-4.5', 'glm-4.6'],
  },
]

// One <select> shared by the Start screen and the running screen. Changing it
// switches the model for the next translation request, mid-session included.
function modelSelectHtml(idAttr: string): string {
  if (!models.length) {
    return `<select id="${idAttr}" class="modelSelect" disabled><option>${t('No models — open Settings')}</option></select>`
  }
  const options = models
    .map(
      m =>
        `<option value="${escapeHtml(m.id)}" ${m.id === selectedModelId ? 'selected' : ''}>${escapeHtml(m.label || m.name || t('(unnamed model)'))}</option>`,
    )
    .join('')
  return `<select id="${idAttr}" class="modelSelect">${options}</select>`
}

function wireModelSelect(app: HTMLDivElement, idAttr: string) {
  app.querySelector<HTMLSelectElement>(`#${idAttr}`)?.addEventListener('change', event => {
    selectedModelId = (event.target as HTMLSelectElement).value
    void saveUiConfig(fullConfig())
  })
}

let stylesInjected = false

export function mountUi(callbacks: UiCallbacks): UiHandle {
  const app = document.querySelector<HTMLDivElement>('#app')!
  injectStyles()
  renderSettings(app, callbacks)

  return {
    showHome(message = '') {
      renderSettings(app, callbacks)
      app.querySelector<HTMLElement>('#settingsError')!.textContent = message
    },
    showEnding(summarizing) {
      app.innerHTML = `
        <main class="panel">
          <header><h1>G2 Translate</h1></header>
          <section class="endingContent" aria-busy="true" role="status" aria-live="polite">
            <span class="summarySpinner" aria-hidden="true"></span>
            <h2>${t(summarizing ? 'Generating AI summary…' : 'Saving session…')}</h2>
            <p class="hint">${t('Returning home when ready.')}</p>
          </section>
        </main>
      `
    },
    showConnecting() {
      app.innerHTML = `
        <main class="panel">
          <div class="status status-connecting">${t('Connecting…')}</div>
        </main>
      `
    },
    showStartError(message) {
      renderSettings(app, callbacks)
      const err = app.querySelector<HTMLParagraphElement>('#settingsError')
      if (err) err.textContent = message
    },
    applyConfig(config) {
      // UI language first — everything re-rendered below picks it up.
      if (config.uiLang === 'zh' || config.uiLang === 'en') setUiLang(config.uiLang)
      // Stored codes can go stale if the language lists change — keep only
      // ones the current lists know.
      const valid = config.sources.filter(c => ASR_LANGUAGES.some(l => l.code === c))
      if (valid.length) selectedSources = new Set(valid)
      if (TARGET_LANGUAGES.some(l => l.code === config.target)) selectedTarget = config.target
      // Service configuration: accept only well-shaped profiles, and keep the
      // active selection pointing at something that exists. URLs saved before
      // scheme normalization existed are healed here.
      relayUrl = withHttps(config.relayUrl)
      sonioxKey = config.sonioxKey
      summaryEnabled = config.summaryEnabled === true
      models = config.models.filter(isProfile).map(m => ({ ...m, url: withHttps(m.url) }))
      if (models.some(m => m.id === config.activeModelId)) selectedModelId = config.activeModelId
      else selectedModelId = models[0]?.id ?? ''
      // Debug payloads (dbgcfg) bypass loadUiConfig's normalization — guard
      // instead of trusting the types.
      if (typeof config.historyRetentionDays === 'number' && config.historyRetentionDays >= 1)
        historyRetentionDays = config.historyRetentionDays
      if (typeof config.historyMaxRecords === 'number' && config.historyMaxRecords >= 1)
        historyMaxRecords = config.historyMaxRecords
      if (typeof config.screenClearSeconds === 'number' && config.screenClearSeconds >= MIN_SCREEN_CLEAR_SECONDS)
        screenClearSeconds = config.screenClearSeconds
      // Re-render only while the user is still on the settings screen — they
      // may already be past it by the time the bridge wakes up.
      if (app.querySelector('#startBtn')) renderSettings(app, callbacks)
    },
    showRunning() {
      app.innerHTML = `
        <main class="panel">
          <header>
            <h1>G2 Translate</h1>
            <div id="status" class="status status-listening">${t('Microphone live')}</div>
          </header>
          <section class="mirror">
            ${mirrorHeading('Original')}
            <div id="originalMirror" class="mirrorText scrollable"></div>
          </section>
          <section class="mirror">
            ${mirrorHeading('Translation')}
            <div id="translationMirror" class="mirrorText scrollable"></div>
          </section>
          <div class="modelRow">
            <h2>${t('Model')}</h2>
            ${modelSelectHtml('runModelSelect')}
          </div>
          <div class="controls">
            <button id="pauseBtn" class="secondary">${t('Pause')}</button>
            <button id="endBtn" class="secondary">${t('End')}</button>
          </div>
          <div id="debugLine" class="debugLine"></div>
          <footer>${t('Tap glasses: toggle layout · swipe: browse history · double-tap: exit')}</footer>
        </main>
      `
      const statusEl = app.querySelector<HTMLDivElement>('#status')!
      const originalEl = app.querySelector<HTMLDivElement>('#originalMirror')!
      const translationEl = app.querySelector<HTMLDivElement>('#translationMirror')!
      const pauseBtn = app.querySelector<HTMLButtonElement>('#pauseBtn')!
      const endBtn = app.querySelector<HTMLButtonElement>('#endBtn')!
      const debugEl = app.querySelector<HTMLDivElement>('#debugLine')!
      wireModelSelect(app, 'runModelSelect')
      wireMirrorCopy(app)

      let paused = false
      pauseBtn.addEventListener('click', () => {
        if (paused) callbacks.onResume()
        else callbacks.onPause()
      })
      endBtn.addEventListener('click', () => callbacks.onEnd())

      // Mirror sync: one div per sealed line, appended as lines arrive; the
      // live line is an extra trailing div whose text is rewritten in place.
      // Incremental so a long session never re-lays-out the whole transcript
      // on every STT partial (the old full-text textContent swap did).
      //
      // The sealed divs are capped at MIRROR_MAX_LINES — the oldest are
      // removed as new ones arrive, so the DOM stays constant-size and the
      // per-partial scrollHeight layout read can't creep up over a long
      // session. The full text still goes to the archive on End; only the
      // phone's in-session scrollback is trimmed.
      //
      // Follow new content only while the user is already at (or near) the
      // bottom — scrolling up to read history must not be yanked back down;
      // scrolling back to the bottom resumes following.
      const MIRROR_MAX_LINES = 300
      const makeMirrorSync = (el: HTMLDivElement) => {
        let count = 0
        let liveEl: HTMLDivElement | null = null
        return (sealed: readonly string[], current?: string) => {
          const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          while (count < sealed.length) {
            const line = document.createElement('div')
            line.textContent = sealed[count++]
            if (liveEl) el.insertBefore(line, liveEl)
            else el.appendChild(line)
          }
          const sealedEls = el.childElementCount - (liveEl ? 1 : 0)
          for (let i = sealedEls - MIRROR_MAX_LINES; i > 0; i--) el.firstElementChild!.remove()
          if (current !== undefined) {
            if (!liveEl) {
              liveEl = document.createElement('div')
              el.appendChild(liveEl)
            }
            liveEl.textContent = current
          }
          if (stick) el.scrollTop = el.scrollHeight
        }
      }
      const syncOriginalMirror = makeMirrorSync(originalEl)
      const syncTranslationMirror = makeMirrorSync(translationEl)

      return {
        setStatus(kind, text) {
          statusEl.className = `status status-${kind}`
          statusEl.textContent = text
        },
        setOriginalMirror(sealed, current) {
          syncOriginalMirror(sealed, current)
        },
        setTranslationMirror(sealed, current) {
          syncTranslationMirror(sealed, current)
        },
        setPaused(next) {
          paused = next
          pauseBtn.textContent = paused ? t('Resume') : t('Pause')
        },
        setDebug(text) {
          debugEl.textContent = text
        },
      }
    },
  }
}

// Settings screen, top to bottom: session history (newest first), the
// compact language bar (opens the bottom-sheet picker), model select, Start.
function renderSettings(app: HTMLDivElement, callbacks: UiCallbacks) {
  app.innerHTML = `
    <main class="panel">
      <header>
        <h1>G2 Translate</h1>
        <div class="headerBtns">
          <button id="langToggle" class="secondary settingsBtn">${getUiLang() === 'zh' ? 'EN' : '中文'}</button>
          <button id="settingsBtn" class="secondary settingsBtn">${t('Settings')}</button>
        </div>
      </header>
      <section class="records">
        <h2>${t('History')}</h2>
        <ul id="recordList" class="recordList"></ul>
      </section>
      <button id="langBar" class="langBar" type="button">
        <span class="langBarText">${langBarText()}</span>
      </button>
      <div class="modelRow">
        <h2>${t('Model')}</h2>
        ${modelSelectHtml('startModelSelect')}
      </div>
      <p class="error" id="settingsError"></p>
      <button id="startBtn">${t('Start')}</button>
    </main>
  `

  app.querySelector<HTMLButtonElement>('#langToggle')!.addEventListener('click', () => {
    setUiLang(getUiLang() === 'zh' ? 'en' : 'zh')
    void saveUiConfig(fullConfig())
    renderSettings(app, callbacks)
  })
  app.querySelector<HTMLButtonElement>('#settingsBtn')!.addEventListener('click', () =>
    renderSettingsPage(app, callbacks),
  )
  app.querySelector<HTMLButtonElement>('#langBar')!.addEventListener('click', () =>
    renderLangSheet(app, callbacks),
  )
  wireModelSelect(app, 'startModelSelect')

  const errorEl = app.querySelector<HTMLParagraphElement>('#settingsError')!
  app.querySelector<HTMLButtonElement>('#startBtn')!.addEventListener('click', () => {
    beginSession(callbacks, errorEl)
  })

  // History fills in asynchronously — storage lives behind the bridge.
  const listEl = app.querySelector<HTMLUListElement>('#recordList')!
  listRecords().then(records => {
    if (!records.length) {
      listEl.innerHTML = `<li class="empty">${t('No saved sessions yet.')}</li>`
      return
    }
    listEl.innerHTML = records.map(recordItemHtml).join('')
    listEl.querySelectorAll<HTMLElement>('.recordMain').forEach(el => {
      el.addEventListener('click', () => renderRecordDetail(app, callbacks, el.dataset.id!))
    })
    listEl.querySelectorAll<HTMLButtonElement>('.recordDelete').forEach(btn => {
      btn.addEventListener('click', async () => {
        await deleteRecord(btn.dataset.id!)
        renderSettings(app, callbacks)
      })
    })
  })
}

function sourceLabels(codes: string[]): string {
  return codes
    .map(c => {
      const l = ASR_LANGUAGES.find(x => x.code === c)
      return l ? langLabel(l) : c
    })
    .join(', ')
}

// Archived records store the English target label; show it in the current UI
// language when it's one we know, pass it through otherwise.
function storedTargetLabel(label: string): string {
  const l = TARGET_LANGUAGES.find(x => x.label === label)
  return l ? langLabel(l) : label
}

// Bottom-sheet language picker (opened from the compact bar): header shows
// the live "EN/DE → ZH" summary, below it the listen-for column (multi-select,
// capped at 3 — extra taps are refused with a hint) and the translate-to
// column (single-select). No confirm step: tapping a chip applies instantly,
// Start is always reachable at the sheet's bottom. Tap the dimmed backdrop to
// dismiss.
function renderLangSheet(app: HTMLDivElement, callbacks: UiCallbacks) {
  app.querySelector('.sheetScrim')?.remove()
  const scrim = document.createElement('div')
  scrim.className = 'sheetScrim'
  app.appendChild(scrim)

  function render() {
    scrim.innerHTML = `
      <div class="langSheet">
        <div class="langSheetHead"><span class="langBarText">${langBarText()}</span></div>
        <div class="sheetCols">
          <div class="sheetCol">
            <h2>${t('Listen for')} <span class="hintInline">${t('up to 3')}</span></h2>
            <div class="chipList">
              ${ASR_LANGUAGES.map(
                l => `
                <button type="button" class="chip ${selectedSources.has(l.code) ? 'active' : ''}" data-kind="src" data-code="${l.code}">
                  <span>${langLabel(l)}</span><span class="hintInline">${l.code}</span>
                </button>
              `,
              ).join('')}
            </div>
          </div>
          <div class="sheetCol">
            <h2>${t('Translate to')}</h2>
            <div class="chipList">
              ${TARGET_LANGUAGES.map(
                l => `
                <button type="button" class="chip ${l.code === selectedTarget ? 'active' : ''}" data-kind="tgt" data-code="${l.code}">
                  <span>${langLabel(l)}</span><span class="hintInline">${l.code.split('-')[0]}</span>
                </button>
              `,
              ).join('')}
            </div>
          </div>
        </div>
        <p class="error" id="sheetError"></p>
        <button id="sheetStart" type="button">${t('Start')}</button>
      </div>
    `

    scrim.querySelectorAll<HTMLButtonElement>('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const code = chip.dataset.code!
        const hint = scrim.querySelector<HTMLParagraphElement>('#sheetError')!
        hint.textContent = ''
        if (chip.dataset.kind === 'src') {
          if (selectedSources.has(code)) selectedSources.delete(code)
          else if (selectedSources.size >= 3) {
            hint.textContent = t('Up to 3 languages — drop one first.')
            return
          } else selectedSources.add(code)
        } else {
          selectedTarget = code
        }
        render()
      })
    })
    scrim.querySelector<HTMLButtonElement>('#sheetStart')!.addEventListener('click', () => {
      beginSession(callbacks, scrim.querySelector<HTMLParagraphElement>('#sheetError')!)
    })
  }

  render()
  scrim.addEventListener('click', event => {
    if (event.target === scrim) {
      scrim.remove()
      // Sync the compact bar with whatever was picked in the sheet.
      app.querySelector('#langBar .langBarText')!.textContent = langBarText()
    }
  })
}

// Standalone settings page (opened from the Start screen's Settings button).
// Edits live in the DOM until Save: relay/key are plain inputs; each model is
// a card whose inputs are collected on save. Fully-blank cards are dropped;
// half-filled ones block the save so a typo can't silently produce a broken
// profile. Back leaves without saving.
function renderSettingsPage(app: HTMLDivElement, callbacks: UiCallbacks) {
  app.innerHTML = `
    <main class="panel">
      <header>
        <button id="settingsBack" class="secondary backBtn">${t('Back')}</button>
        <h1 class="detailTitle">${t('Settings')}</h1>
      </header>
      <div class="pageBody">
        <label class="field">
          <h2>${t('Relay URL')}</h2>
          <input id="relayInput" class="editTarget" type="text" inputmode="url" readonly
            autocomplete="off" spellcheck="false"
            placeholder="https://your-worker.workers.dev" value="${escapeHtml(relayUrl)}" />
        </label>
        <label class="field">
          <h2>${t('Soniox API Key')}</h2>
          <input id="sonioxKeyInput" class="editTarget" type="password" readonly inputmode="none"
            autocomplete="off" spellcheck="false"
            placeholder="${t('Your Soniox key')}" value="${escapeHtml(sonioxKey)}" />
        </label>
        <div class="fieldHeader">
          <h2>${t('History')}</h2>
        </div>
        <label class="field">
          <h2>${t('Keep sessions for (days)')}</h2>
          <input id="historyDaysInput" class="hDays editTarget" type="number" inputmode="numeric" readonly
            autocomplete="off" spellcheck="false"
            placeholder="${DEFAULT_HISTORY_RETENTION_DAYS}" value="${historyRetentionDays}" />
        </label>
        <label class="field">
          <h2>${t('Keep at most (sessions)')}</h2>
          <input id="historyCountInput" class="hCount editTarget" type="number" inputmode="numeric" readonly
            autocomplete="off" spellcheck="false"
            placeholder="${DEFAULT_HISTORY_MAX_RECORDS}" value="${historyMaxRecords}" />
        </label>
        <div class="fieldHeader">
          <h2>${t('Display')}</h2>
        </div>
        <label class="switchRow">
          <span>${t('AI summary')}</span>
          <input id="summaryEnabledInput" type="checkbox" role="switch" ${summaryEnabled ? 'checked' : ''} />
          <span class="switchTrack" aria-hidden="true"></span>
        </label>
        <label class="field">
          <h2>${t('Clear screen after silence (seconds)')}</h2>
          <input id="screenClearInput" class="sClear editTarget" type="number" inputmode="numeric" readonly
            autocomplete="off" spellcheck="false"
            placeholder="${DEFAULT_SCREEN_CLEAR_SECONDS}" value="${screenClearSeconds}" />
        </label>
        <div class="fieldHeader">
          <h2>${t('Translation models')}</h2>
          <button id="addModelBtn" class="secondary settingsBtn">${t('+ Add')}</button>
        </div>
        <div id="modelRows" class="modelRows"></div>
      </div>
      <p class="error" id="modalError"></p>
      <button id="modalSave">${t('Save')}</button>
    </main>
  `

  const rows = app.querySelector<HTMLDivElement>('#modelRows')!

  // A preset select sits at the top of each card; picking one fills
  // name/URL and swaps the model-ID suggestions, leaving the key alone.
  // Custom leaves everything manual.
  function presetKeyFor(profile: ModelProfile | null): string {
    return MODEL_PRESETS.find(p => p.url && p.url === profile?.url)?.key ?? 'custom'
  }

  function modelCardHtml(profile: ModelProfile | null): string {
    const id = profile?.id ?? ''
    const key = presetKeyFor(profile)
    const ids = MODEL_PRESETS.find(p => p.key === key)?.ids ?? []
    return `
      <div class="modelCard" data-id="${escapeHtml(id)}">
        <div class="modelCardHead">
          <select class="mPreset">
            ${MODEL_PRESETS.map(
              p => `<option value="${p.key}" ${p.key === key ? 'selected' : ''}>${p.label}</option>`,
            ).join('')}
          </select>
          <button class="recordDelete removeModel" aria-label="${t('Remove')}">✕</button>
        </div>
        <input class="mLabel editTarget" type="text" readonly inputmode="none"
          autocomplete="off" spellcheck="false"
          placeholder="${t('NAME (shown in the list, e.g. DeepSeek)')}" value="${escapeHtml(profile?.label ?? '')}" />
        <input class="mModel editTarget" type="text" readonly inputmode="none"
          autocomplete="off" spellcheck="false" list="ids-${escapeHtml(id || 'new')}"
          placeholder="${t('MODEL ID (pick or type, e.g. deepseek-v4-flash)')}" value="${escapeHtml(profile?.name ?? '')}" />
        <datalist id="ids-${escapeHtml(id || 'new')}">
          ${ids.map(i => `<option value="${escapeHtml(i)}"></option>`).join('')}
        </datalist>
        <input class="mUrl editTarget" type="text" inputmode="url" readonly
          autocomplete="off" spellcheck="false"
          placeholder="${t('URL (e.g. https://api.deepseek.com/chat/completions)')}" value="${escapeHtml(profile?.url ?? '')}" />
        <input class="mKey editTarget" type="password" readonly inputmode="none"
          autocomplete="off" spellcheck="false"
          placeholder="${t('API KEY')}" value="${escapeHtml(profile?.key ?? '')}" />
        <input class="mExtra editTarget" type="text" readonly inputmode="none"
          autocomplete="off" spellcheck="false"
          placeholder="${t('EXTRA PARAMS (optional JSON, e.g. {"thinking":{"type":"disabled"}} to disable thinking)')}"
          value="${escapeHtml(profile?.extraParams ? JSON.stringify(profile.extraParams) : '')}" />
        <input class="mEffort editTarget" type="text" readonly inputmode="none"
          autocomplete="off" spellcheck="false"
          placeholder="${t('REASONING EFFORT (optional, e.g. low / high / max for GLM-5.3+)')}"
          value="${escapeHtml(profile?.reasoningEffort ?? '')}" />
      </div>
    `
  }

  if (!models.length) {
    rows.innerHTML = `<p class="empty">${t('No models yet — add the one you want to translate with.')}</p>`
  } else {
    rows.innerHTML = models.map(m => modelCardHtml(m)).join('')
  }

  app.querySelector<HTMLButtonElement>('#settingsBack')!.addEventListener('click', () => renderSettings(app, callbacks))
  app.querySelector<HTMLButtonElement>('#addModelBtn')!.addEventListener('click', () => {
    rows.querySelector('.empty')?.remove()
    rows.insertAdjacentHTML('beforeend', modelCardHtml(null))
    // Focus the first input of the fresh card so typing can start right away.
    rows.querySelector<HTMLInputElement>('.modelCard:last-child .mLabel')?.focus()
  })
  rows.addEventListener('click', event => {
    if (!(event.target as HTMLElement).classList.contains('removeModel')) return
    ;(event.target as HTMLElement).closest('.modelCard')?.remove()
  })
  rows.addEventListener('change', event => {
    const select = event.target as HTMLSelectElement
    if (!select.classList.contains('mPreset')) return
    const preset = MODEL_PRESETS.find(p => p.key === select.value)
    const card = select.closest<HTMLDivElement>('.modelCard')!
    if (preset?.url) {
      card.querySelector<HTMLInputElement>('.mLabel')!.value = preset.name
      card.querySelector<HTMLInputElement>('.mUrl')!.value = preset.url
    }
    // Prefill the thinking-off param; Custom (no extra) leaves the box alone.
    if (preset?.extra) {
      card.querySelector<HTMLInputElement>('.mExtra')!.value = preset.extra
    }
    // Swap the suggestion list; the typed model ID itself is left untouched.
    card.querySelector<HTMLDataListElement>('datalist')!.innerHTML = (preset?.ids ?? [])
      .map(i => `<option value="${escapeHtml(i)}"></option>`)
      .join('')
  })

  // iOS keyboards cover bottom-anchored inputs, so no field is ever focused
  // in place: every editTarget is readonly + inputmode=none, and tapping one
  // opens this sheet pinned to the TOP of the screen where the keyboard can't
  // reach. OK (or the keyboard's done key) writes the value back.
  const fieldNames: Record<string, string> = {
    relayInput: 'Relay URL',
    sonioxKeyInput: 'Soniox API Key',
    mLabel: 'Name',
    mModel: 'Model ID',
    mUrl: 'URL',
    mKey: 'API Key',
    mExtra: 'Extra params (JSON)',
    mEffort: 'Reasoning effort',
  }

  function openEditor(src: HTMLInputElement) {
    app.querySelector('.editScrim')?.remove()
    const label =
      src.closest('.field')?.querySelector('h2')?.textContent ??
      t(fieldNames[src.className.split(' ')[0]] ?? 'Edit')
    const scrim = document.createElement('div')
    scrim.className = 'editScrim'
    scrim.innerHTML = `
      <div class="editSheet">
        <h2>${escapeHtml(label)}</h2>
        <div class="editRow">
          <input class="editInput" type="${src.type}" ${
            src.inputMode === 'url' ? 'inputmode="url"' : src.inputMode === 'numeric' ? 'inputmode="numeric"' : ''
          } enterkeyhint="done"
            autocomplete="off" spellcheck="false"
            ${src.getAttribute('list') ? `list="${escapeHtml(src.getAttribute('list')!)}"` : ''}
            placeholder="${escapeHtml(src.placeholder)}" value="${escapeHtml(src.value)}" />
          <button class="editCancel secondary settingsBtn">${t('Cancel')}</button>
          <button class="editOk settingsBtn">${t('OK')}</button>
        </div>
      </div>
    `
    app.appendChild(scrim)
    const editor = scrim.querySelector<HTMLInputElement>('.editInput')!
    const commit = () => {
      src.value = editor.value
      scrim.remove()
    }
    scrim.querySelector<HTMLButtonElement>('.editOk')!.addEventListener('click', commit)
    scrim.querySelector<HTMLButtonElement>('.editCancel')!.addEventListener('click', () => scrim.remove())
    editor.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commit()
      }
    })
    // Focus synchronously: iOS only raises the keyboard for focus() calls
    // inside the user-gesture handler — deferring it breaks that chain.
    editor.focus()
  }

  app.querySelector('main')!.addEventListener('click', event => {
    const target = event.target as HTMLElement
    if (target instanceof HTMLInputElement && target.classList.contains('editTarget')) {
      event.preventDefault()
      openEditor(target)
    }
  })

  app.querySelector<HTMLButtonElement>('#modalSave')!.addEventListener('click', () => {
    const errorEl = app.querySelector<HTMLParagraphElement>('#modalError')!
    const relay = withHttps(app.querySelector<HTMLInputElement>('#relayInput')!.value).replace(/\/+$/, '')
    const sttKey = app.querySelector<HTMLInputElement>('#sonioxKeyInput')!.value.trim()

    // History retention: blank falls back to the default; anything else must
    // be a whole number ≥ 1.
    const daysRaw = app.querySelector<HTMLInputElement>('#historyDaysInput')!.value.trim()
    const countRaw = app.querySelector<HTMLInputElement>('#historyCountInput')!.value.trim()
    const days = daysRaw === '' ? DEFAULT_HISTORY_RETENTION_DAYS : Number(daysRaw)
    const count = countRaw === '' ? DEFAULT_HISTORY_MAX_RECORDS : Number(countRaw)
    if (!Number.isInteger(days) || days < 1) {
      errorEl.textContent = t('History days must be a whole number of 1 or more.')
      return
    }
    if (!Number.isInteger(count) || count < 1) {
      errorEl.textContent = t('History record cap must be a whole number of 1 or more.')
      return
    }

    // Screen clear: blank falls back to the default; anything else must be a
    // whole number ≥ MIN_SCREEN_CLEAR_SECONDS — below that the idle marker's
    // big-dot phase could never show before the screen clears.
    const clearRaw = app.querySelector<HTMLInputElement>('#screenClearInput')!.value.trim()
    const clearSeconds = clearRaw === '' ? DEFAULT_SCREEN_CLEAR_SECONDS : Number(clearRaw)
    if (!Number.isInteger(clearSeconds) || clearSeconds < MIN_SCREEN_CLEAR_SECONDS) {
      errorEl.textContent = tf('Screen clear must be a whole number of {min} seconds or more.', {
        min: MIN_SCREEN_CLEAR_SECONDS,
      })
      return
    }

    const next: ModelProfile[] = []
    for (const card of [...rows.querySelectorAll<HTMLDivElement>('.modelCard')]) {
      // Extra params are optional vendor-specific body params — parsed here so
      // invalid JSON can't reach the relay.
      const rawExtra = card.querySelector<HTMLInputElement>('.mExtra')!.value.trim()
      let extraParams: Record<string, unknown> | undefined
      if (rawExtra) {
        try {
          extraParams = JSON.parse(rawExtra) as Record<string, unknown>
        } catch {
          errorEl.textContent = tf('"{label}": extra params are not valid JSON.', {
            label: card.querySelector<HTMLInputElement>('.mLabel')!.value.trim() || t('New model'),
          })
          return
        }
        if (!extraParams || typeof extraParams !== 'object' || Array.isArray(extraParams)) {
          errorEl.textContent = t('Extra params must be a JSON object, e.g. {"thinking":{"type":"disabled"}}.')
          return
        }
      }
      const profile: ModelProfile = {
        id: card.dataset.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        label: card.querySelector<HTMLInputElement>('.mLabel')!.value.trim(),
        name: card.querySelector<HTMLInputElement>('.mModel')!.value.trim(),
        url: withHttps(card.querySelector<HTMLInputElement>('.mUrl')!.value).replace(/\/+$/, ''),
        key: card.querySelector<HTMLInputElement>('.mKey')!.value.trim(),
        ...(extraParams ? { extraParams } : {}),
        // Sent only when filled — blank means the param is left out entirely.
        ...(card.querySelector<HTMLInputElement>('.mEffort')!.value.trim()
          ? { reasoningEffort: card.querySelector<HTMLInputElement>('.mEffort')!.value.trim() }
          : {}),
      }
      if (!profile.label && !profile.name && !profile.url && !profile.key) continue // blank card — drop
      if (!profile.label || !profile.name || !profile.url || !profile.key) {
        errorEl.textContent = t('Each model needs a name, model ID, URL, and key — fill it in or remove it.')
        return
      }
      if (!isHttpUrl(profile.url)) {
        errorEl.textContent = tf('"{label}": the URL doesn\'t look like a valid http(s) address.', {
          label: profile.label,
        })
        return
      }
      next.push(profile)
    }

    if (relay && !isHttpUrl(relay)) {
      errorEl.textContent = t("The relay URL doesn't look like a valid http(s) address.")
      return
    }

    relayUrl = relay
    sonioxKey = sttKey
    models = next
    historyRetentionDays = days
    historyMaxRecords = count
    screenClearSeconds = clearSeconds
    summaryEnabled = app.querySelector<HTMLInputElement>('#summaryEnabledInput')!.checked
    if (!models.some(m => m.id === selectedModelId)) selectedModelId = models[0]?.id ?? ''

    void saveUiConfig(fullConfig())
    renderSettings(app, callbacks)
  })
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function recordItemHtml(r: SessionRecord): string {
  const preview = (r.original || r.translation).replace(/\s+/g, ' ').trim().slice(0, 80)
  return `
    <li class="recordItem">
      <div class="recordMain" data-id="${r.id}">
        <div class="recordTitle">${sourceLabels(r.sourceLangs)} → ${storedTargetLabel(r.targetLang)} · ${formatTime(r.savedAt)}</div>
        <div class="recordPreview">${escapeHtml(preview)}</div>
      </div>
      <button class="recordDelete" data-id="${r.id}" aria-label="${t('Delete')}">✕</button>
    </li>
  `
}

// Full text of one saved session; Back returns to the settings screen.
async function renderRecordDetail(app: HTMLDivElement, callbacks: UiCallbacks, id: string) {
  const record = await getRecord(id)
  if (!record) return
  app.innerHTML = `
    <main class="panel">
      <header>
        <button id="backBtn" class="secondary backBtn">${t('Back')}</button>
        <h1 class="detailTitle">${escapeHtml(`${sourceLabels(record.sourceLangs)} → ${storedTargetLabel(record.targetLang)}`)}</h1>
      </header>
      <p class="detailTime">${formatTime(record.savedAt)}</p>
      <div class="mirrorStack">
        ${summaryEnabled ? mirrorPanel('AI summary', 'summaryMirror', true, record.summary || t('No summary yet.')) : ''}
        ${mirrorPanel('Original', 'originalMirror', !summaryEnabled, record.original)}
        ${mirrorPanel('Translation', 'translationMirror', !summaryEnabled, record.translation)}
      </div>
      <div class="controls">
        <button id="detailDelete" class="secondary">${t('Delete')}</button>
      </div>
    </main>
  `
  wireMirrorToggles(app)
  wireMirrorCopy(app)
  if (summaryEnabled && !record.summary) {
    const summaryBody = app.querySelector<HTMLElement>('#summaryMirrorBody')!
    const summaryText = app.querySelector<HTMLElement>('#summaryMirror')!
    const copy = summaryBody.closest('.mirror')!.querySelector<HTMLButtonElement>('.mirrorCopy')!
    copy.disabled = true
    const retry = document.createElement('button')
    retry.className = 'secondary summaryRetry'
    retry.textContent = t('Generate summary')
    retry.disabled = !record.original.trim()
    summaryBody.appendChild(retry)
    retry.addEventListener('click', async () => {
      const model = getSelectedModel()
      if (!relayUrl || !model) {
        summaryText.textContent = t('Configure a relay and model in Settings first.')
        return
      }
      const back = app.querySelector<HTMLButtonElement>('#backBtn')!
      const remove = app.querySelector<HTMLButtonElement>('#detailDelete')!
      retry.disabled = back.disabled = remove.disabled = true
      retry.textContent = t('Generating AI summary…')
      retry.classList.add('isGenerating')
      summaryBody.setAttribute('aria-busy', 'true')
      try {
        const summary = await generateSummary(record.original, record.targetLang, relayUrl, model)
        await saveRecordSummary(record.id, summary)
        summaryText.textContent = summary
        copy.disabled = false
        retry.remove()
      } catch {
        summaryText.textContent = t('Summary failed. Try again.')
      } finally {
        retry.disabled = back.disabled = remove.disabled = false
        retry.classList.remove('isGenerating')
        retry.textContent = t('Generate summary')
        summaryBody.removeAttribute('aria-busy')
      }
    })
  }
  app.querySelector<HTMLButtonElement>('#backBtn')!.addEventListener('click', () =>
    renderSettings(app, callbacks),
  )
  app.querySelector<HTMLButtonElement>('#detailDelete')!.addEventListener('click', async () => {
    await deleteRecord(record.id)
    renderSettings(app, callbacks)
  })
}

type MirrorLabel = 'Original' | 'Translation' | 'AI summary'

function mirrorPanel(label: MirrorLabel, id: string, expanded: boolean, content = ''): string {
  return `
    <section class="mirror${expanded ? '' : ' collapsed'}">
      ${mirrorHeading(label, `${id}Body`, expanded)}
      <div id="${id}Body" class="mirrorBody" ${expanded ? '' : 'hidden'}>
        <div id="${id}" class="mirrorText scrollable">${escapeHtml(content)}</div>
      </div>
    </section>
  `
}

function wireMirrorToggles(app: HTMLDivElement): void {
  for (const button of app.querySelectorAll<HTMLButtonElement>('.mirrorToggle')) {
    button.addEventListener('click', () => {
      const mirror = button.closest('.mirror')!
      const body = mirror.querySelector<HTMLElement>('.mirrorBody')!
      const expanded = button.getAttribute('aria-expanded') !== 'true'
      button.setAttribute('aria-expanded', String(expanded))
      mirror.classList.toggle('collapsed', !expanded)
      body.hidden = !expanded
    })
  }
}

function mirrorHeading(label: MirrorLabel, bodyId?: string, expanded = true): string {
  const copyLabel = t(label === 'Original' ? 'Copy original' : label === 'Translation' ? 'Copy translation' : 'Copy summary')
  const glassId = label.replaceAll(' ', '')
  return `
    <div class="mirrorHeading">
      <h2>${bodyId ? `<button type="button" class="mirrorToggle" aria-expanded="${expanded}" aria-controls="${bodyId}">
        <svg class="foldChevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>
        ${t(label)}
      </button>` : t(label)}</h2>
      <button type="button" class="mirrorCopy" aria-label="${copyLabel}" title="${copyLabel}">
        <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="copyGlass${glassId}" x1="0" y1="0" x2="1" y2="1">
              <stop stop-color="#fff" stop-opacity=".28"/>
              <stop offset="1" stop-color="#fff" stop-opacity=".06"/>
            </linearGradient>
          </defs>
          <g stroke="#E5E5E5" stroke-width=".8" stroke-linejoin="round">
            <path d="M14 3h8l6 6v14a2 2 0 0 1-2 2H14a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"
              fill="url(#copyGlass${glassId})" stroke-opacity=".45"/>
            <path d="M22 3v6h6" fill="#fff" fill-opacity=".16" stroke-opacity=".45"/>
            <path d="M6 10h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V12a2 2 0 0 1 2-2Z"
              fill="url(#copyGlass${glassId})" stroke-opacity=".7"/>
            <path d="M14 10v6h6" fill="#fff" fill-opacity=".22" stroke-opacity=".65"/>
          </g>
        </svg>
      </button>
      <span class="copyFeedback" role="status" aria-live="polite"></span>
    </div>
  `
}

function wireMirrorCopy(app: HTMLDivElement): void {
  for (const mirror of app.querySelectorAll<HTMLElement>('.mirror')) {
    const button = mirror.querySelector<HTMLButtonElement>('.mirrorCopy')!
    const text = mirror.querySelector<HTMLElement>('.mirrorText')!
    const feedback = mirror.querySelector<HTMLElement>('.copyFeedback')!
    let feedbackTimer: ReturnType<typeof setTimeout> | undefined
    button.addEventListener('click', async () => {
      clearTimeout(feedbackTimer)
      // Live mirrors contain a div per line; textContent alone would join words
      // across line boundaries. Archived mirrors already contain plain text.
      const content = text.childElementCount
        ? Array.from(text.children, line => line.textContent ?? '').join('\n')
        : text.textContent ?? ''
      if (!content.trim()) {
        feedback.textContent = t('No text to copy')
      } else {
        button.disabled = true
        try {
          await copyText(content)
          feedback.textContent = t('Copied')
        } catch {
          feedback.textContent = t('Copy failed. Try again.')
        } finally {
          button.disabled = false
        }
      }
      feedbackTimer = setTimeout(() => { feedback.textContent = '' }, 2500)
    })
  }
}

async function copyText(content: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(content)
      return
    } catch {
      // Some embedded WebViews deny the async API but allow user-triggered copy.
    }
  }
  // LAN HTTP preview pages have no Clipboard API. Keep the selection fallback
  // inside the click flow, with a read-only field so mobile keyboards stay shut.
  const focused = document.activeElement
  const selection = window.getSelection()
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
    : []
  const field = document.createElement('textarea')
  field.value = content
  field.readOnly = true
  field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;font-size:16px'
  document.body.appendChild(field)
  try {
    field.focus({ preventScroll: true })
    field.select()
    field.setSelectionRange(0, field.value.length)
    if (!document.execCommand('copy')) throw new Error('Clipboard copy failed')
  } finally {
    field.remove()
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true })
    if (selection) {
      selection.removeAllRanges()
      for (const range of ranges) selection.addRange(range)
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function injectStyles() {
  if (stylesInjected) return
  stylesInjected = true
  // Even Hub phone-side design tokens (dark mode): --color-bg #111111,
  // --color-surface #1A1A1A, --color-accent #FEF991 (sparingly). #3CFA44 is
  // glasses-only and must never appear in phone-side UI.
  const css = `
    :root { color-scheme: dark; }
    html, body { margin: 0; height: 100%; background: #111111; color: #E5E5E5;
      font: 16px/1.4 -apple-system, BlinkMacSystemFont, 'Helvetica Neue', system-ui, sans-serif;
      touch-action: manipulation; -webkit-text-size-adjust: 100%;
      overscroll-behavior: none; }
    #app { display: flex; height: 100%; }
    .panel { display: flex; flex-direction: column; gap: 16px; height: 100%;
      width: 100%; max-width: 640px; margin: 0 auto; padding: 24px; box-sizing: border-box; }
    header { display: flex; align-items: center; justify-content: space-between; }
    h1 { font-size: 18px; font-weight: 600; margin: 0; letter-spacing: 0.02em; }
    h2 { font-size: 13px; font-weight: 600; margin: 0 0 8px; color: #919191;
      text-transform: uppercase; letter-spacing: 0.04em; }
    .status { font-size: 12px; padding: 4px 10px; border-radius: 999px;
      border: 1px solid transparent; letter-spacing: 0.04em; text-transform: uppercase;
      width: fit-content; }
    .status-connecting { color: #A7A7A7; border-color: #3E3E3E; }
    .status-listening  { color: #FEF991; border-color: #FEF991; background: rgba(254,249,145,0.08); }
    .status-error      { color: #FF453A; border-color: #FF453A; background: rgba(255,69,58,0.08); }
    .hint { font-size: 14px; color: #A7A7A7; margin: 0; }
    .hintInline { text-transform: none; letter-spacing: 0; font-weight: 400; color: #7B7B7B; }
    .error { font-size: 13px; color: #FF453A; min-height: 16px; margin: 0; }
    button { background: #FEF991; color: #111111; border: none; border-radius: 8px;
      padding: 12px; font-size: 15px; font-weight: 600; cursor: pointer; }
    button.secondary { background: #1A1A1A; color: #E5E5E5; border: 1px solid #2E2E2E; }
    .controls { display: flex; gap: 12px; }
    .controls button { flex: 1; }

    /* Settings: history takes the leftover height and scrolls internally;
       the language columns and Start stay fixed below it. */
    .records { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; }
    .recordList { flex: 1 1 0; min-height: 0; overflow-y: auto; margin: 0; padding: 0;
      list-style: none; display: flex; flex-direction: column; gap: 8px; }
    .recordItem { display: flex; align-items: center; gap: 8px; background: #1A1A1A;
      border: 1px solid #2E2E2E; border-radius: 8px; padding: 10px 12px; }
    .recordMain { flex: 1; min-width: 0; cursor: pointer; }
    .recordTitle { font-size: 13px; color: #FEF991; margin-bottom: 2px; }
    .recordPreview { font-size: 13px; color: #A7A7A7; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; }
    .recordDelete { background: none; border: none; color: #FF453A; font-size: 15px;
      padding: 4px 8px; cursor: pointer; font-weight: 400; }
    .empty { font-size: 13px; color: #7B7B7B; padding: 8px 2px; }

    /* Language selection: compact bar + bottom-sheet picker. */
    .langBar { display: block; width: 100%; background: #1A1A1A; border: 1px solid #2E2E2E;
      border-radius: 12px; padding: 18px 16px; cursor: pointer; text-align: center; }
    .langBarText { font-size: 26px; font-weight: 600; letter-spacing: 0.08em; color: #E5E5E5; }
    .sheetScrim { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 15;
      display: flex; align-items: flex-end; justify-content: center; }
    .langSheet { width: 100%; max-width: 640px; background: #111111; border: 1px solid #2E2E2E;
      border-bottom: none; border-radius: 16px 16px 0 0; padding: 20px; box-sizing: border-box;
      display: flex; flex-direction: column; gap: 14px; }
    .langSheetHead { text-align: center; }
    .sheetCols { display: flex; gap: 12px; }
    .sheetCol { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
    .chipList { overflow-y: auto; max-height: 38vh; display: flex; flex-direction: column; gap: 8px; }
    .chip { display: flex; align-items: center; justify-content: space-between; gap: 8px;
      background: #1A1A1A; color: #7B7B7B; border: 1px solid #2E2E2E; border-radius: 8px;
      padding: 10px 12px; font-size: 14px; font-weight: 400; cursor: pointer; text-align: left; }
    .chip.active { color: #E5E5E5; border-color: #FEF991; background: rgba(254,249,145,0.08); }

    .backBtn { padding: 8px 16px; }
    .detailTitle { flex: 1; min-width: 0; font-size: 15px; text-align: right; }
    .detailTime { margin: -8px 0 0; font-size: 12px; color: #7B7B7B; text-align: right; }

    .mirrorStack { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column;
      gap: 16px; overflow-y: auto; }
    .mirror { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column;
      background: #1A1A1A; border: 1px solid #2E2E2E; border-radius: 12px; padding: 16px; }
    .mirrorStack > .mirror:not(.collapsed) { min-height: 100px; }
    .mirror.collapsed { flex: 0 0 auto; min-height: 0; }
    .mirror.collapsed .mirrorHeading { margin-bottom: 0; }
    .mirrorBody { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; gap: 12px; }
    .mirrorBody[hidden] { display: none; }
    .mirrorHeading { position: relative; display: flex; align-items: center; flex-shrink: 0;
      min-height: 20px; margin-bottom: 8px; }
    .mirrorHeading h2 { margin: 0; flex: 1; min-width: 0; }
    .mirrorToggle { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px;
      margin: -12px 0; padding: 12px 0; background: transparent; color: inherit;
      font: inherit; letter-spacing: inherit; text-transform: inherit; text-align: left; }
    .mirrorToggle:focus-visible { outline: 2px solid #FEF991; outline-offset: 2px; }
    .foldChevron { width: 14px; height: 14px; flex-shrink: 0; fill: none; stroke: currentColor;
      stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
    .mirrorToggle[aria-expanded="true"] .foldChevron { transform: rotate(90deg); }
    .mirrorCopy { display: grid; place-items: center; flex-shrink: 0; width: 44px; height: 44px;
      margin: -12px -12px -12px auto; padding: 8px; background: transparent; color: #E5E5E5; }
    .mirrorCopy svg { width: 28px; height: 28px; filter: drop-shadow(0 1px 2px rgba(0,0,0,.25)); }
    .mirrorCopy:active { background: rgba(255,255,255,.08); }
    .mirrorCopy:focus-visible { outline: 2px solid #FEF991; outline-offset: -2px; }
    .mirrorCopy:disabled { cursor: wait; opacity: .6; }
    @media (hover: hover) { .mirrorCopy:hover { background: rgba(255,255,255,.06); } }
    .copyFeedback { position: absolute; right: 36px; top: 0; max-width: calc(100% - 36px);
      background: #1A1A1A; color: #E5E5E5; font-size: 12px; line-height: 20px; }
    .copyFeedback:not(:empty) { padding: 0 6px; }
    .mirrorText { margin: 0; font-size: 16px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; min-height: 24px; }
    .mirrorText.scrollable { flex: 1 1 0; min-height: 0; overflow-y: auto; }
    .summaryRetry { align-self: flex-start; flex-shrink: 0; font-size: 13px; }
    .summaryRetry:disabled { opacity: .6; cursor: default; }
    .endingContent { flex: 1; display: flex; flex-direction: column; align-items: center;
      justify-content: center; gap: 16px; text-align: center; }
    .endingContent h2 { margin: 8px 0 0; color: #E5E5E5; font-size: 16px; text-transform: none; }
    .summarySpinner, .isGenerating::before { display: inline-block; width: 40px; height: 40px;
      border: 2px solid #2E2E2E; border-top-color: #FEF991; border-radius: 50%;
      animation: summarySpin .9s linear infinite; }
    .isGenerating::before { content: ''; width: 12px; height: 12px; margin-right: 8px; vertical-align: middle; }
    @keyframes summarySpin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .summarySpinner, .isGenerating::before { animation: none; } }
    .debugLine { font-size: 11px; color: #7B7B7B; text-align: center; min-height: 14px; }
    footer { font-size: 12px; color: #7B7B7B; text-align: center; }

    /* Model switching (Start + running screens). */
    .settingsBtn { padding: 8px 14px; font-size: 13px; font-weight: 600; }
    .headerBtns { display: flex; gap: 8px; }
    .modelRow { display: flex; flex-direction: column; }
    .modelSelect { width: 100%; background: #1A1A1A; color: #E5E5E5; border: 1px solid #2E2E2E;
      border-radius: 8px; padding: 10px 12px; font-size: 14px; }
    .modelSelect:disabled { color: #7B7B7B; }

    /* Settings page — full screen like the record detail; body scrolls. */
    .pageBody { flex: 1 1 0; min-height: 0; overflow-y: auto;
      display: flex; flex-direction: column; gap: 12px; }
    .field { display: flex; flex-direction: column; }
    .switchRow { position: relative; display: flex; align-items: center; justify-content: space-between;
      gap: 16px; min-height: 44px; padding: 8px 16px; background: #1A1A1A;
      border: 1px solid #2E2E2E; border-radius: 12px; font-size: 14px; cursor: pointer; }
    .switchRow input { position: absolute; right: 16px; width: 44px; height: 28px;
      margin: 0; opacity: 0; cursor: pointer; }
    .switchTrack { width: 44px; height: 26px; flex-shrink: 0; background: #3E3E3E;
      border-radius: 999px; pointer-events: none; }
    .switchTrack::before { content: ''; display: block; width: 20px; height: 20px;
      margin: 3px; border-radius: 50%; background: #E5E5E5; }
    .switchRow input:checked + .switchTrack { background: #FEF991; }
    .switchRow input:checked + .switchTrack::before { transform: translateX(18px); background: #111111; }
    .switchRow input:focus-visible + .switchTrack { outline: 2px solid #FEF991; outline-offset: 3px; }
    .field input, .modelCard input { background: rgba(255,255,255,0.08); color: #E5E5E5;
      border: none; border-radius: 8px; padding: 10px 12px; font-size: 14px; width: 100%;
      box-sizing: border-box; }
    .field input::placeholder, .modelCard input::placeholder { color: #7B7B7B; }
    .fieldHeader { display: flex; align-items: center; justify-content: space-between; }
    .modelRows { display: flex; flex-direction: column; gap: 8px; }
    .modelCard { background: #1A1A1A; border: 1px solid #2E2E2E; border-radius: 8px;
      padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .modelCardHead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .mPreset { flex: 1; background: rgba(255,255,255,0.08); color: #E5E5E5; border: none;
      border-radius: 8px; padding: 8px 12px; font-size: 14px; font-weight: 600; }

    /* Top-pinned edit sheet: keyboard rises against it instead of covering
       the field being edited. 16px input font keeps iOS from zooming. */
    .editScrim { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 20;
      display: flex; justify-content: center; align-items: flex-start; }
    .editSheet { width: 100%; max-width: 640px; background: #111111; border: 1px solid #2E2E2E;
      border-top: none; border-radius: 0 0 16px 16px; padding: 16px 20px;
      padding-top: calc(16px + env(safe-area-inset-top)); box-sizing: border-box;
      display: flex; flex-direction: column; gap: 10px; }
    .editRow { display: flex; gap: 8px; }
    .editInput { flex: 1; min-width: 0; background: rgba(255,255,255,0.08); color: #E5E5E5;
      border: none; border-radius: 8px; padding: 10px 12px; font-size: 16px; }
    .editInput::placeholder { color: #7B7B7B; font-size: 14px; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
