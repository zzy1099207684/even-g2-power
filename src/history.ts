// Persisted archive of finished translation sessions, stored through the Even
// bridge's local storage — the plugin's own persistent storage. Not the
// webview's localStorage, which the host app may wipe.

import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'

export interface SessionRecord {
  id: string
  savedAt: number // epoch ms
  sourceLangs: string[] // ASR language codes used in the session
  targetLang: string // translation target, as a natural-language name
  original: string
  translation: string
}

const STORAGE_KEY = 'g2-translate-history'

export async function listRecords(): Promise<SessionRecord[]> {
  try {
    const bridge = await waitForEvenAppBridge()
    const raw = await bridge.getLocalStorage(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as SessionRecord[]) : []
  } catch {
    return []
  }
}

// Newest first: prepend, then persist.
export async function addRecord(record: SessionRecord): Promise<void> {
  const records = await listRecords()
  records.unshift(record)
  await persist(records)
}

export async function deleteRecord(id: string): Promise<void> {
  await persist((await listRecords()).filter(r => r.id !== id))
}

export async function getRecord(id: string): Promise<SessionRecord | null> {
  return (await listRecords()).find(r => r.id === id) ?? null
}

async function persist(records: SessionRecord[]): Promise<void> {
  const bridge = await waitForEvenAppBridge()
  await bridge.setLocalStorage(STORAGE_KEY, JSON.stringify(records))
}
