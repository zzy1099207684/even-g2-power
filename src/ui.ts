// Phone-side companion UI: settings screen (session history, language pickers,
// Start), the running mirror of what's on the glasses, and a per-record
// detail view. Pure DOM rendering — no SDK/bridge calls here; persistence goes
// through the async record helpers in history.ts.

import { listRecords, getRecord, deleteRecord, type SessionRecord } from './history'

const ASR_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ru', label: 'Russian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'it', label: 'Italian' },
  { code: 'nl', label: 'Dutch' },
]

// Any language DeepSeek writes well is a valid target; the ASR list above is
// the one bound to Deepgram's model.
const TARGET_LANGUAGES = [
  { code: 'zh-Hans', label: 'Chinese (Simplified)' },
  { code: 'zh-Hant', label: 'Chinese (Traditional)' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'de', label: 'German' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'ru', label: 'Russian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'nl', label: 'Dutch' },
  { code: 'hi', label: 'Hindi' },
]

// Selection survives leaving and re-entering the settings screen (record
// detail, running session).
const selectedSources = new Set<string>(['de'])
let selectedTarget = TARGET_LANGUAGES[0].code

type StatusKind = 'listening' | 'error'

export interface RunningUiHandle {
  setStatus(kind: StatusKind, text: string): void
  setOriginalMirror(text: string): void
  setTranslationMirror(text: string): void
  setPaused(paused: boolean): void
}

export interface UiHandle {
  showConnecting(): void
  showStartError(message: string): void
  /** Back to the settings screen, e.g. after End — no error banner. */
  showSettings(): void
  showRunning(): RunningUiHandle
}

export interface UiCallbacks {
  onStart(sources: string[], targetLang: string): void
  onPause(): void
  onResume(): void
  onEnd(): void
}

let stylesInjected = false

export function mountUi(callbacks: UiCallbacks): UiHandle {
  const app = document.querySelector<HTMLDivElement>('#app')!
  injectStyles()
  renderSettings(app, callbacks)

  return {
    showConnecting() {
      app.innerHTML = `
        <main class="panel">
          <div class="status status-connecting">Connecting…</div>
        </main>
      `
    },
    showStartError(message) {
      renderSettings(app, callbacks)
      const err = app.querySelector<HTMLParagraphElement>('#settingsError')
      if (err) err.textContent = message
    },
    showSettings() {
      renderSettings(app, callbacks)
    },
    showRunning() {
      app.innerHTML = `
        <main class="panel">
          <header>
            <h1>G2 Translate</h1>
            <div id="status" class="status status-listening">Microphone live</div>
          </header>
          <section class="mirror">
            <h2>Original</h2>
            <p id="originalMirror" class="mirrorText scrollable"></p>
          </section>
          <section class="mirror">
            <h2>Translation</h2>
            <p id="translationMirror" class="mirrorText scrollable"></p>
          </section>
          <div class="controls">
            <button id="pauseBtn" class="secondary">Pause</button>
            <button id="endBtn" class="secondary">End</button>
          </div>
          <footer>Tap glasses: toggle layout · swipe: browse history · double-tap: exit</footer>
        </main>
      `
      const statusEl = app.querySelector<HTMLDivElement>('#status')!
      const originalEl = app.querySelector<HTMLParagraphElement>('#originalMirror')!
      const translationEl = app.querySelector<HTMLParagraphElement>('#translationMirror')!
      const pauseBtn = app.querySelector<HTMLButtonElement>('#pauseBtn')!
      const endBtn = app.querySelector<HTMLButtonElement>('#endBtn')!

      let paused = false
      pauseBtn.addEventListener('click', () => {
        if (paused) callbacks.onResume()
        else callbacks.onPause()
      })
      endBtn.addEventListener('click', () => callbacks.onEnd())

      // Follow new content only while the user is already at (or near) the
      // bottom — scrolling up to read history must not be yanked back down;
      // scrolling back to the bottom resumes following.
      const setMirror = (el: HTMLParagraphElement, text: string) => {
        const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        el.textContent = text
        if (stick) el.scrollTop = el.scrollHeight
      }

      return {
        setStatus(kind, text) {
          statusEl.className = `status status-${kind}`
          statusEl.textContent = text
        },
        setOriginalMirror(text) {
          setMirror(originalEl, text)
        },
        setTranslationMirror(text) {
          setMirror(translationEl, text)
        },
        setPaused(next) {
          paused = next
          pauseBtn.textContent = paused ? 'Resume' : 'Pause'
        },
      }
    },
  }
}

// Settings screen, top to bottom: session history (newest first), the two
// scrollable language columns (listen-for multi-select → translate-to
// single-select), Start.
function renderSettings(app: HTMLDivElement, callbacks: UiCallbacks) {
  app.innerHTML = `
    <main class="panel">
      <header><h1>G2 Translate</h1></header>
      <section class="records">
        <h2>History</h2>
        <ul id="recordList" class="recordList"></ul>
      </section>
      <section class="langsRow">
        <div class="langCol">
          <h2>Listen for <span class="hintInline">up to 3</span></h2>
          <div class="langList">
            ${ASR_LANGUAGES.map(
              l => `
              <label class="lang">
                <input type="checkbox" value="${l.code}" ${selectedSources.has(l.code) ? 'checked' : ''} />
                <span>${l.label}</span>
              </label>
            `,
            ).join('')}
          </div>
        </div>
        <div class="langArrow">→</div>
        <div class="langCol">
          <h2>Translate to</h2>
          <div class="langList">
            ${TARGET_LANGUAGES.map(
              l => `
              <label class="lang">
                <input type="radio" name="targetLang" value="${l.code}" ${l.code === selectedTarget ? 'checked' : ''} />
                <span>${l.label}</span>
              </label>
            `,
            ).join('')}
          </div>
        </div>
      </section>
      <p class="error" id="settingsError"></p>
      <button id="startBtn">Start</button>
    </main>
  `

  app.querySelectorAll<HTMLInputElement>('.lang input[type="checkbox"]').forEach(input => {
    input.addEventListener('change', () => {
      if (input.checked) selectedSources.add(input.value)
      else selectedSources.delete(input.value)
    })
  })
  app.querySelectorAll<HTMLInputElement>('.lang input[type="radio"]').forEach(input => {
    input.addEventListener('change', () => {
      selectedTarget = input.value
    })
  })

  const errorEl = app.querySelector<HTMLParagraphElement>('#settingsError')!
  const startBtn = app.querySelector<HTMLButtonElement>('#startBtn')!
  startBtn.addEventListener('click', () => {
    const sources = [...selectedSources]
    if (sources.length < 1 || sources.length > 3) {
      errorEl.textContent = 'Pick 1 to 3 languages to listen for.'
      return
    }
    errorEl.textContent = ''
    const target = TARGET_LANGUAGES.find(l => l.code === selectedTarget) ?? TARGET_LANGUAGES[0]
    callbacks.onStart(sources, target.label)
  })

  // History fills in asynchronously — storage lives behind the bridge.
  const listEl = app.querySelector<HTMLUListElement>('#recordList')!
  listRecords().then(records => {
    if (!records.length) {
      listEl.innerHTML = `<li class="empty">No saved sessions yet.</li>`
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
  return codes.map(c => ASR_LANGUAGES.find(l => l.code === c)?.label ?? c).join(', ')
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
        <div class="recordTitle">${sourceLabels(r.sourceLangs)} → ${r.targetLang} · ${formatTime(r.savedAt)}</div>
        <div class="recordPreview">${escapeHtml(preview)}</div>
      </div>
      <button class="recordDelete" data-id="${r.id}" aria-label="Delete">✕</button>
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
        <button id="backBtn" class="secondary backBtn">Back</button>
        <h1 class="detailTitle">${escapeHtml(`${sourceLabels(record.sourceLangs)} → ${record.targetLang}`)}</h1>
      </header>
      <p class="detailTime">${formatTime(record.savedAt)}</p>
      <section class="mirror">
        <h2>Original</h2>
        <p class="mirrorText scrollable"></p>
      </section>
      <section class="mirror">
        <h2>Translation</h2>
        <p class="mirrorText scrollable"></p>
      </section>
      <div class="controls">
        <button id="detailDelete" class="secondary">Delete</button>
      </div>
    </main>
  `
  const mirrors = app.querySelectorAll<HTMLParagraphElement>('.mirrorText')
  mirrors[0].textContent = record.original
  mirrors[1].textContent = record.translation
  app.querySelector<HTMLButtonElement>('#backBtn')!.addEventListener('click', () =>
    renderSettings(app, callbacks),
  )
  app.querySelector<HTMLButtonElement>('#detailDelete')!.addEventListener('click', async () => {
    await deleteRecord(record.id)
    renderSettings(app, callbacks)
  })
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

    .langsRow { display: flex; gap: 12px; align-items: stretch; }
    .langCol { flex: 1 1 0; min-width: 0; }
    .langArrow { align-self: center; color: #FEF991; font-size: 18px; }
    .langList { max-height: 168px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
    .lang { display: flex; align-items: center; gap: 8px; background: #1A1A1A;
      border: 1px solid #2E2E2E; border-radius: 8px; padding: 8px 12px; font-size: 14px; }
    .lang input { accent-color: #FEF991; width: 16px; height: 16px; flex: none; }

    .backBtn { padding: 8px 16px; }
    .detailTitle { flex: 1; min-width: 0; font-size: 15px; text-align: right; }
    .detailTime { margin: -8px 0 0; font-size: 12px; color: #7B7B7B; text-align: right; }

    .mirror { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column;
      background: #1A1A1A; border: 1px solid #2E2E2E; border-radius: 12px; padding: 16px; }
    .mirrorText { margin: 0; font-size: 16px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; min-height: 24px; }
    .mirrorText.scrollable { flex: 1 1 0; min-height: 0; overflow-y: auto; }
    footer { font-size: 12px; color: #7B7B7B; text-align: center; }
  `
  const style = document.createElement('style')
  style.textContent = css
  document.head.appendChild(style)
}
