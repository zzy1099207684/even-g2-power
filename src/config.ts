// Persisted UI configuration — the language selection the user last started
// with, plus the user-provided service configuration (relay URL, Soniox
// key, one or more translation-model profiles). Stored through the Even
// bridge's local storage (same mechanism as history.ts: the plugin's own
// persistent storage, not the webview's localStorage, which the host app may
// wipe). Nothing here has a built-in default — every value comes from the
// user; Start refuses to run until the required fields are filled.

import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'

export interface ModelProfile {
  id: string
  /** Display label shown in the model dropdowns. */
  label: string
  /** API model identifier sent to the provider (e.g. "deepseek-v4-flash"). */
  name: string
  /** Full chat/completions endpoint the relay forwards to. */
  url: string
  key: string
  /** Optional vendor-specific request-body params (e.g. GLM/DeepSeek
   *  {"thinking":{"type":"disabled"}}), merged into the upstream body by the
   *  relay. Parsed at save time. */
  extraParams?: Record<string, unknown>
  /** Optional reasoning_effort sent as a top-level body param (GLM-5.3+
   *  low/high/max); the relay merges it over extraParams' same-named key. */
  reasoningEffort?: string
}

export interface UiConfig {
  sources: string[]
  target: string
  /** The user's own deployed relay (worker) base URL — forwards translation. */
  relayUrl: string
  sonioxKey: string
  models: ModelProfile[]
  activeModelId: string
  /** Session-archive retention (Settings → History): drop archived sessions
   *  older than this many days, keep at most this many. Optional in stored
   *  and debug payloads — loadUiConfig resolves absent/invalid values to the
   *  defaults below. */
  historyRetentionDays?: number
  historyMaxRecords?: number
  /** Seconds of content silence before the glasses' live view resets to a
   *  fresh page. Optional in stored and debug payloads — loadUiConfig
   *  resolves absent/invalid values to the default below. */
  screenClearSeconds?: number
  /** Companion-UI language ('en' | 'zh'). Optional in stored payloads —
   *  loadUiConfig resolves absent values to 'en'. */
  uiLang?: string
  summaryEnabled?: boolean
}

// Defaults applied when a config predates the history-retention fields or
// carries invalid ones. Also the placeholder hints in the Settings inputs.
export const DEFAULT_HISTORY_RETENTION_DAYS = 30
export const DEFAULT_HISTORY_MAX_RECORDS = 200
export const DEFAULT_SCREEN_CLEAR_SECONDS = 15
// Floor for screenClearSeconds: below 5 the idle marker's big-dot phase
// (MARKER_RETURN_AFTER_MS) could never show before the screen clears.
export const MIN_SCREEN_CLEAR_SECONDS = 5

// Everything handleStart needs from the settings screen, resolved and
// validated there before the session opens.
export interface SessionConfig {
  relayUrl: string
  sonioxKey: string
  model: ModelProfile
  /** Seconds of silence before the glasses' live view clears to a fresh page. */
  screenClearSeconds: number
  summaryEnabled?: boolean
}

const STORAGE_KEY = 'g2-translate-config'

export async function loadUiConfig(): Promise<UiConfig | null> {
  try {
    const bridge = await waitForEvenAppBridge()
    const raw = await bridge.getLocalStorage(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<UiConfig>
    if (!Array.isArray(parsed.sources) || typeof parsed.target !== 'string') return null
    // Missing service fields default to empty so the stored language selection
    // still applies and Settings asks for the rest.
    return {
      sources: parsed.sources,
      target: parsed.target,
      relayUrl: typeof parsed.relayUrl === 'string' ? parsed.relayUrl : '',
      sonioxKey: typeof parsed.sonioxKey === 'string' ? parsed.sonioxKey : '',
      models: Array.isArray(parsed.models)
        ? parsed.models.filter(
            (m): m is ModelProfile =>
              !!m &&
              typeof m.id === 'string' &&
              typeof m.label === 'string' &&
              typeof m.name === 'string' &&
              typeof m.url === 'string' &&
              typeof m.key === 'string' &&
              // extraParams is optional; when present it must be a JSON object
              // (arrays would spread into the body as numbered keys).
              (!m.extraParams ||
                (typeof m.extraParams === 'object' && !Array.isArray(m.extraParams))) &&
              // reasoningEffort is optional; when present it must be a string
              (!m.reasoningEffort || typeof m.reasoningEffort === 'string'),
          )
        : [],
      activeModelId: typeof parsed.activeModelId === 'string' ? parsed.activeModelId : '',
      historyRetentionDays:
        typeof parsed.historyRetentionDays === 'number' && parsed.historyRetentionDays >= 1
          ? parsed.historyRetentionDays
          : DEFAULT_HISTORY_RETENTION_DAYS,
      historyMaxRecords:
        typeof parsed.historyMaxRecords === 'number' && parsed.historyMaxRecords >= 1
          ? parsed.historyMaxRecords
          : DEFAULT_HISTORY_MAX_RECORDS,
      screenClearSeconds:
        typeof parsed.screenClearSeconds === 'number' && parsed.screenClearSeconds >= MIN_SCREEN_CLEAR_SECONDS
          ? parsed.screenClearSeconds
          : DEFAULT_SCREEN_CLEAR_SECONDS,
      uiLang: parsed.uiLang === 'zh' ? 'zh' : 'en',
      summaryEnabled: parsed.summaryEnabled === true,
    }
  } catch {
    return null // no saved config yet, or storage unavailable — defaults apply
  }
}

export async function saveUiConfig(config: UiConfig): Promise<void> {
  try {
    const bridge = await waitForEvenAppBridge()
    await bridge.setLocalStorage(STORAGE_KEY, JSON.stringify(config))
  } catch {
    // Best-effort: worst case the next open falls back to the built-in defaults.
  }
}
