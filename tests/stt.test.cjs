const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')

const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/asr/stt.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

async function start() {
  let socket
  class Socket {
    static OPEN = 1
    readyState = 0
    constructor() { socket = this }
    send() { assert.equal(this.readyState, Socket.OPEN) }
    close() { this.readyState = 3 }
  }
  const loaded = { exports: {} }
  vm.runInNewContext(`(function(module, exports) { ${code}\n})`, { WebSocket: Socket })(loaded, loaded.exports)
  const stable = [], drafts = [], ends = [], drops = []
  const record = entries => (text, langs) => entries.push({ text, langs: Array.from(langs) })
  const opening = loaded.exports.startSonioxStream({
    apiKey: 'test-only', languageHints: ['en'],
    onStable: record(stable), onLive: record(drafts), onEnd: record(ends),
    onDrop: (text, reason) => drops.push({ text, reason }),
  })
  socket.readyState = Socket.OPEN
  socket.onopen()
  await opening
  return {
    stable, drafts, ends, drops,
    receive(tokens) { socket.onmessage({ data: JSON.stringify({ tokens }) }) },
  }
}

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
