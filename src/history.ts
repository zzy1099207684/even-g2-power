// Persisted archive of finished translation sessions, stored through the Even
// bridge's local storage — the plugin's own persistent storage. Not the
// webview's localStorage, which the host app may wipe.

import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { diagnostics } from './diagnostics'
import {
  DEFAULT_HISTORY_MAX_RECORDS,
  DEFAULT_HISTORY_RETENTION_DAYS,
  loadUiConfig,
} from './config'

export interface SessionRecord {
  id: string
  savedAt: number // epoch ms
  sourceLangs: string[] // ASR language codes used in the session
  targetLang: string // translation target, as a natural-language name
  original: string
  translation: string
  summary?: string
}

const STORAGE_KEY = 'g2-translate-history'

// Retention limits are user-configurable (Settings → History); the defaults
// in config.ts apply when no saved config says otherwise. prune() runs on the
// add path — the only place the archive grows.

// Distinguishes "no records yet" ([]) from "storage read failed" (null).
// The write paths must never treat a failed read as an empty archive —
// persisting over it would wipe every saved session.
async function readRecords(): Promise<SessionRecord[] | null> {
  try {
    const bridge = await waitForEvenAppBridge()
    const raw = await bridge.getLocalStorage(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    diagnostics.log('history', 'loaded', { records: Array.isArray(parsed) ? parsed.length : 0, valid: Array.isArray(parsed) })
    return Array.isArray(parsed) ? (parsed as SessionRecord[]) : []
  } catch (err) {
    diagnostics.error('history', 'load_failed', err)
    return null
  }
}

export async function listRecords(): Promise<SessionRecord[]> {
  return (await readRecords()) ?? []
}

// Drops records past the retention window, then the overflow past the count
// cap. Records are newest first, so the slice keeps the newest.
function prune(records: SessionRecord[], retentionMs: number, maxRecords: number): SessionRecord[] {
  const cutoff = Date.now() - retentionMs
  return records.filter(r => r.savedAt >= cutoff).slice(0, maxRecords)
}

// Newest first: prepend, then persist. A failed read aborts the save — the
// new record is lost this once, but the archive is never overwritten blank.
export async function addRecord(record: SessionRecord): Promise<void> {
  diagnostics.log('history', 'add', { id: record.id, originalChars: record.original.length, translationChars: record.translation.length })
  const records = await readRecords()
  if (records === null) throw new Error('history read failed — refusing to overwrite the archive')
  const cfg = await loadUiConfig()
  const retentionDays = cfg?.historyRetentionDays ?? DEFAULT_HISTORY_RETENTION_DAYS
  const maxRecords = cfg?.historyMaxRecords ?? DEFAULT_HISTORY_MAX_RECORDS
  records.unshift(record)
  await persist(prune(records, retentionDays * 24 * 60 * 60 * 1000, maxRecords))
}

export async function deleteRecord(id: string): Promise<void> {
  diagnostics.log('history', 'delete', { id })
  const records = await readRecords()
  if (records === null) return // read failed — rewriting would wipe the archive
  await persist(records.filter(r => r.id !== id))
}

export async function getRecord(id: string): Promise<SessionRecord | null> {
  return (await listRecords()).find(r => r.id === id) ?? null
}

export async function saveRecordSummary(id: string, summary: string): Promise<void> {
  diagnostics.log('history', 'save_summary', { id, chars: summary.length })
  const records = await readRecords()
  if (records === null) throw new Error('history read failed')
  const record = records.find(r => r.id === id)
  if (!record) throw new Error('record not found')
  record.summary = summary
  await persist(records)
}

async function persist(records: SessionRecord[]): Promise<void> {
  const startedAt = Date.now()
  diagnostics.log('history', 'save_request', { records: records.length })
  try {
    const bridge = await waitForEvenAppBridge()
    if (!await bridge.setLocalStorage(STORAGE_KEY, JSON.stringify(records))) throw new Error('history write failed')
    diagnostics.log('history', 'saved', { records: records.length, elapsedMs: Date.now() - startedAt })
  } catch (err) {
    diagnostics.error('history', 'save_failed', err, { elapsedMs: Date.now() - startedAt })
    throw err
  }
}
