const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')

const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/diagnostics.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
function logger() {
  const loaded = { exports: {} }
  vm.runInNewContext(`(function(module,exports){${code}\n})`, {
    setTimeout: () => 1, clearTimeout() {},
  })(loaded, loaded.exports)
  return loaded.exports.createDiagnostics()
}

test('one export orders operations, measurements and errors without conversation content', () => {
  const log = logger()
  log.log('session', 'start', { languages: 'en,de' })
  log.count('mic.frames', 2)
  log.count('stt.sentBytes', 3200)
  log.sample({ paused: false })
  log.error('stt', 'timeout', new Error('request timeout'))
  const text = log.exportText()
  assert.ok(text.indexOf('session.start') < text.indexOf('health.sample'))
  assert.ok(text.indexOf('health.sample') < text.indexOf('stt.timeout'))
  assert.match(text, /"mic.frames":2/)
  assert.match(text, /"stt.sentBytes":3200/)
  assert.match(text, /request timeout/)
})

test('credentials and payload fields never enter export or persistence', async () => {
  const log = logger()
  const saved = []
  await log.attachStorage({ read: async () => '', write: async text => { saved.push(text); return true } })
  log.protect(['private-test-key'])
  log.log('test', 'payload', { apiKey: 'other-secret', text: 'private transcript', body: { key: 'nested-secret' }, chars: 18 })
  log.error('network', 'failed', new Error('Bearer private-test-key https://user:pass@example.com/path?key=secret'))
  await log.flush()
  for (const text of [log.exportText(), ...saved]) {
    for (const secret of ['private-test-key', 'other-secret', 'private transcript', 'nested-secret', 'user:pass', '?key=secret']) {
      assert.ok(!text.includes(secret), secret)
    }
  }
})

test('a long test retains recent events within a fixed size and reports eviction', () => {
  const log = logger()
  for (let i = 0; i < 2000; i++) log.log('test', 'event', { index: i, detail: 'x'.repeat(700) })
  const text = log.exportText()
  assert.ok(text.length < 170_000)
  assert.match(text, /"index":1999/)
  assert.ok(!text.includes('"index":0,'))
  assert.match(text, /evicted=[1-9]/)
})

test('stored logs restore before events that occurred while storage was loading', async () => {
  const first = logger()
  let stored = ''
  await first.attachStorage({ read: async () => '', write: async text => { stored = text; return true } })
  first.log('session', 'end')
  await first.flush()
  const next = logger()
  let resolve
  const restore = next.attachStorage({ read: () => new Promise(done => { resolve = done }), write: async () => true })
  next.log('app', 'boot')
  resolve(stored)
  await restore
  const text = next.exportText()
  assert.ok(text.indexOf('session.end') < text.indexOf('app.boot'))
})

test('a failed save does not reject logging and remains visible in memory', async () => {
  const log = logger()
  await log.attachStorage({ read: async () => '', write: async () => false })
  log.log('session', 'pause')
  await log.flush()
  assert.match(log.exportText(), /session.pause/)
  assert.match(log.exportText(), /diagnostics.save_failed/)
  log.log('session', 'resume')
  assert.match(log.exportText(), /session.resume/)
})

test('concurrent saves are serialized and newer events are not overwritten', async () => {
  const log = logger()
  const writes = []
  let release
  await log.attachStorage({ read: async () => '', write: text => {
    writes.push(text)
    return new Promise(done => { release = done })
  } })
  log.log('test', 'first')
  const saving = log.flush()
  log.log('test', 'second')
  await log.flush()
  assert.equal(writes.length, 1)
  release(true)
  await saving
  const latest = log.flush()
  assert.equal(writes.length, 2)
  release(true)
  await latest
  assert.match(writes[1], /test.second/)
})

test('invalid saved data does not discard current events', async () => {
  const log = logger()
  log.log('app', 'boot')
  await log.attachStorage({ read: async () => '{broken', write: async () => true })
  assert.match(log.exportText(), /app.boot/)
  assert.match(log.exportText(), /diagnostics.restore_failed/)
})
