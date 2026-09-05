const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')

const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/asr/stt.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

async function start({ autoOpen = true } = {}) {
  let socket, timeout
  class Socket {
    static OPEN = 1
    readyState = 0
    constructor() { socket = this }
    send() { assert.equal(this.readyState, Socket.OPEN) }
    close() { this.readyState = 3 }
  }
  const loaded = { exports: {} }
  const diagnosticModule = { exports: {} }
  const diagnosticCode = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/diagnostics.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(`(function(module,exports){${diagnosticCode}\n})`)(diagnosticModule, diagnosticModule.exports)
  vm.runInNewContext(`(function(require, module, exports) { ${code}\n})`, {
    WebSocket: Socket,
    setTimeout: callback => { timeout = callback; return 1 },
    clearTimeout: () => { timeout = null },
  })(() => diagnosticModule.exports, loaded, loaded.exports)
  const stable = [], drafts = [], ends = [], drops = [], errors = []
  const record = entries => (text, langs) => entries.push({ text, langs: Array.from(langs) })
  const opening = loaded.exports.startSonioxStream({
    apiKey: 'test-only', languageHints: ['en'],
    onStable: record(stable), onLive: record(drafts), onEnd: record(ends),
    onDrop: (text, reason) => drops.push({ text, reason }),
    onError: error => errors.push(error),
  })
  let client
  if (autoOpen) {
    socket.readyState = Socket.OPEN
    socket.onopen()
    client = await opening
  }
  return {
    stable, drafts, ends, drops, errors, socket, opening, client,
    logs: () => diagnosticModule.exports.diagnostics.exportText(),
    expire: () => timeout?.(),
    receive(tokens) { socket.onmessage({ data: JSON.stringify({ tokens }) }) },
  }
}

test('connection timeout rejects the pending handshake and reports one recoverable error', async () => {
  const app = await start({ autoOpen: false })
  app.expire()
  assert.equal(app.socket.readyState, 3)
  await assert.rejects(app.opening, /timed out/i)
  assert.equal(app.errors.length, 1)
  assert.equal(app.errors[0].retryable, true)
})

test('transport diagnostics distinguish sent audio, server replies and API errors without secrets', async () => {
  const app = await start()
  app.client.sendPcm(new Uint8Array(3200))
  app.receive([{ text: 'private speech', language: 'en', is_final: true }])
  app.socket.onmessage({ data: JSON.stringify({ error_type: 'request_timeout', error_code: 408, error_message: 'timeout', request_id: 'req-123' }) })
  const text = app.logs()
  assert.match(text, /stt.open/)
  assert.match(text, /"stt.sentBytes":3200/)
  assert.match(text, /"stt.responses":2/)
  assert.match(text, /req-123/)
  assert.ok(!text.includes('private speech'))
  assert.ok(!text.includes('test-only'))
})

test('server errors retain retryability and are not reported again on close', async () => {
  for (const [type, retryable] of [['REQUEST_TIMEOUT', true], ['service_unavailable', true], ['max_duration_reached', true], ['unauthenticated', false]]) {
    const app = await start()
    app.socket.onmessage({ data: JSON.stringify({ error_type: type, error_message: 'Test server error' }) })
    app.socket.onclose?.({ code: 1000, reason: '' })
    assert.equal(app.errors.length, 1)
    assert.equal(app.errors[0].retryable, retryable)
    assert.equal(app.socket.readyState, 3)
  }
})

test('closing an opened client cancels timeout and suppresses later transport errors', async () => {
  const app = await start()
  app.client.close()
  app.expire()
  app.socket.onerror?.(new Error('late failure'))
  app.socket.onclose?.({ code: 1006, reason: '' })
  assert.equal(app.errors.length, 0)
  assert.equal(app.socket.readyState, 3)
})

test('keeps an entire final word when its subwords have different confidence scores', async () => {
  const app = await start()
  app.receive([
    { text: 'hell', language: 'en', confidence: 0.1, is_final: true },
    { text: 'o', language: 'en', confidence: 0.99, is_final: true },
  ])
  assert.deepEqual(app.stable, [{ text: 'hello', langs: ['en', 'en', 'en', 'en', 'en'] }])
  assert.deepEqual(app.drops, [])
})

test('keeps a low-confidence final prefix when the rest of its word arrives later', async () => {
  const app = await start()
  app.receive([{ text: 'hell', language: 'en', confidence: 0.1, is_final: true }])
  app.receive([
    { text: 'o', language: 'en', confidence: 0.99, is_final: true },
    { text: '<end>', is_final: true },
  ])
  assert.deepEqual(app.stable, [{ text: 'hell', langs: ['en', 'en', 'en', 'en'] }])
  assert.deepEqual(app.drops, [])
  assert.deepEqual(app.ends, [{ text: 'o', langs: ['en'] }])
})

test('drafts preserve uncertain word fragments until the recognizer revises them', async () => {
  const app = await start()
  app.receive([
    { text: 'hell', language: 'en', confidence: 0.1, is_final: false },
    { text: 'o', language: 'en', confidence: 0.99, is_final: false },
  ])
  assert.deepEqual(app.drafts, [{ text: 'hello', langs: ['en', 'en', 'en', 'en', 'en'] }])
  assert.deepEqual(app.drops, [])
  app.receive([{ text: 'yellow', language: 'en', confidence: 0.9, is_final: false }])
  assert.deepEqual(app.drafts[1], { text: 'yellow', langs: ['en', 'en', 'en', 'en', 'en', 'en'] })
})

test('keeps uncertain words and spaces in an utterance-ending response', async () => {
  const app = await start()
  app.receive([
    { text: 'hello', language: 'en', confidence: 0.2, is_final: true },
    { text: ' ', confidence: 0.1, is_final: true },
    { text: 'world', language: 'en', confidence: 0.1, is_final: true },
    { text: '<end>', is_final: true },
  ])
  assert.deepEqual(app.ends, [{
    text: 'hello world',
    langs: ['en', 'en', 'en', 'en', 'en', undefined, 'en', 'en', 'en', 'en', 'en'],
  }])
  assert.deepEqual(app.drops, [])
})

test('tokens without a confidence score remain accepted', async () => {
  const app = await start()
  app.receive([{ text: 'hello', language: 'en', is_final: true }])
  assert.deepEqual(app.stable, [{ text: 'hello', langs: ['en', 'en', 'en', 'en', 'en'] }])
  assert.deepEqual(app.drops, [])
})

test('unselected language and script filters still apply independently of confidence', async () => {
  const app = await start()
  app.receive([
    { text: '<docroot>', is_final: true },
    { text: '你好', language: 'en', confidence: 0.99, is_final: true },
    { text: 'bonjour', language: 'fr', confidence: 0.99, is_final: true },
    { text: 'hello', language: 'en', confidence: 0.99, is_final: true },
  ])
  assert.deepEqual(app.stable, [{ text: 'hello', langs: ['en', 'en', 'en', 'en', 'en'] }])
  assert.deepEqual(app.drops, [
    { text: '你好', reason: 'script' },
    { text: 'bonjour', reason: 'fr' },
  ])
})
