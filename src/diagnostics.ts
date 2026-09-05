// One bounded, local timeline for the app. Callers pass metadata and counts,
// never audio, transcripts, request bodies or complete service configuration.
type Fields = Record<string, unknown>
interface LogStorage {
  read(): Promise<string>
  write(value: string): Promise<boolean>
}
const MAX_LINES = 800
const MAX_CHARS = 160_000
const PRIVATE_FIELDS = /^(key|apiKey|api_key|sonioxKey|authorization|headers|body|text|content|original|translation|summary|audio|audioPcm|pcm|password)$/i

export function createDiagnostics() {
  let lines: string[] = []
  let chars = 0
  let evicted = 0
  let dirty = false
  let ready = false
  let saving = false
  let storage: LogStorage | undefined
  let storageState = 'memory'
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const secrets = new Set<string>()
  const counters: Record<string, number> = {}
  const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  function redact(value: string): string {
    let result = value
    for (const secret of secrets) result = result.split(secret).join('[redacted]')
    return result
      .replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
      .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, url => url.replace(/\/\/[^/@]+@/, '//').split(/[?#]/)[0])
  }

  function fields(input: Fields): Fields {
    const output: Fields = {}
    for (const [key, value] of Object.entries(input).slice(0, 64)) {
      if (PRIVATE_FIELDS.test(key)) continue
      if (typeof value === 'string') output[key] = redact(value).slice(0, 600)
      else if (typeof value === 'boolean' || value === null) output[key] = value
      else if (typeof value === 'number' && Number.isFinite(value)) output[key] = value
    }
    return output
  }

  function trim() {
    while (lines.length > MAX_LINES || chars > MAX_CHARS) {
      chars -= lines.shift()!.length + 1
      evicted++
    }
  }

  function schedule(delay = 5000) {
    if (!ready || !storage || saveTimer !== undefined) return
    saveTimer = setTimeout(() => { saveTimer = undefined; void flush() }, delay)
  }

  function append(scope: string, event: string, data: Fields, persist = true) {
    const line = `${new Date().toISOString()} ${run} ${scope}.${event} ${JSON.stringify(fields(data))}`
    lines.push(line)
    chars += line.length + 1
    trim()
    dirty = true
    if (persist) schedule()
  }

  function log(scope: string, event: string, data: Fields = {}) {
    append(scope, event, data)
  }

  function error(scope: string, event: string, err: unknown, data: Fields = {}) {
    const value = err as { name?: string; message?: string; stack?: string } | null
    // JSON parser errors can embed a snippet of a private response or config.
    const syntaxError = value?.name === 'SyntaxError'
    append(scope, event, { ...data, errorName: value?.name,
      message: syntaxError ? 'Invalid JSON or syntax' : value?.message ?? String(err), stack: syntaxError ? undefined : value?.stack })
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = undefined
    schedule(0)
  }

  async function flush(): Promise<void> {
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveTimer = undefined
    if (!ready || !storage || saving || !dirty) return
    saving = true
    dirty = false
    storageState = 'saving'
    try {
      if (!await storage.write(JSON.stringify({ v: 1, evicted, lines: lines.map(redact) }))) throw new Error('storage returned false')
      storageState = 'saved'
    } catch (err) {
      storageState = 'save_failed'
      append('diagnostics', 'save_failed', { message: (err as Error)?.message ?? String(err) }, false)
    } finally {
      saving = false
      // A failed log write must neither block the app nor retry itself forever.
      if (dirty && storageState === 'saved') schedule()
    }
  }

  async function attachStorage(next: LogStorage): Promise<void> {
    storage = next
    storageState = 'loading'
    try {
      const raw = await next.read()
      if (raw) {
        const stored = JSON.parse(raw) as { v?: number; lines?: unknown; evicted?: number }
        if (stored.v !== 1 || !Array.isArray(stored.lines) || !stored.lines.every(line => typeof line === 'string')) {
          throw new Error('invalid diagnostic snapshot')
        }
        lines = [...stored.lines.slice(-MAX_LINES) as string[], ...lines]
        chars = lines.reduce((sum, line) => sum + line.length + 1, 0)
        evicted += typeof stored.evicted === 'number' ? stored.evicted : 0
        trim()
      }
      storageState = 'ready'
    } catch (err) {
      storageState = 'restore_failed'
      append('diagnostics', 'restore_failed', { message: (err as Error)?.message ?? String(err) }, false)
    }
    ready = true
    schedule()
  }

  return {
    log, error, flush, attachStorage,
    protect(values: string[]) { for (const value of values) if (value) secrets.add(value) },
    count(key: string, amount = 1): number {
      if (!(key in counters) && Object.keys(counters).length >= 64) return 0
      return counters[key] = (counters[key] ?? 0) + amount
    },
    gauge(key: string, value: number) {
      if (key in counters || Object.keys(counters).length < 64) counters[key] = value
    },
    sample(data: Fields = {}) { log('health', 'sample', { ...counters, ...data }) },
    exportText(): string {
      return `G2 Translate diagnostics v1\nExported: ${new Date().toISOString()}\nStorage: ${storageState}; evicted=${evicted}\nCounters: ${JSON.stringify(counters)}\n\n${lines.map(redact).join('\n')}`
    },
  }
}

export const diagnostics = createDiagnostics()
