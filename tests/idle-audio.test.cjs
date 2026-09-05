const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')

const compiled = new Map()
const settle = () => new Promise(resolve => setImmediate(resolve))

// 100 ms of s16le audio with a known RMS. No network or device recording.
function pcm(amplitude) {
  const bytes = Buffer.alloc(3200)
  for (let i = 0; i < 1600; i++) bytes.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2)
  return bytes
}

function assertAudio(actual, amplitudes) {
  const expected = Buffer.concat(amplitudes.map(pcm))
  assert.equal(actual.length, expected.length, 'Audio must retain every expected sample')
  assert.ok(actual.equals(expected), 'Audio samples must remain unchanged and in order')
}

// Run the complete main.ts and STT client. Replace only device, transport,
// phone UI and display effects; drive the registered PCM event callback.
async function startApp({ startupError } = {}) {
  let now = 100_000
  let callbacks
  let onEvent
  const sockets = []
  const statuses = []
  const timers = new Map()
  let nextTimer = 0
  function advance(ms) {
    now += ms
    for (const [id, timer] of timers) {
      if (timer.at > now) continue
      if (timer.interval) timer.at = now + timer.interval
      else timers.delete(id)
      timer.callback()
    }
  }
  const bridge = {
    getLocalStorage: async () => null,
    setLocalStorage: async () => true,
    createStartUpPageContainer: async () => {
      if (startupError) sockets[0].serverError(startupError, 401)
      return 0
    },
    audioControl: async () => true,
    onEvenHubEvent(callback) {
      onEvent = callback
      return () => { onEvent = null }
    },
  }
  class Property {
    constructor(props) { Object.assign(this, props) }
  }
  class Socket {
    static OPEN = 1
    readyState = 0
    audio = []
    constructor() { sockets.push(this) }
    send(data) {
      assert.equal(this.readyState, 1)
      if (typeof data !== 'string') this.audio.push(Buffer.from(data))
    }
    close() { this.readyState = 3 }
    async open() {
      this.readyState = 1
      this.onopen()
      await settle()
    }
    async fail() {
      this.readyState = 3
      this.onerror?.(new Error('Test handshake failure'))
      await settle()
    }
    receive(message) { this.onmessage?.({ data: JSON.stringify(message) }) }
    serverError(type, code = 408) {
      this.receive({ error_type: type, error_code: code, error_message: type, tokens: [] })
      this.readyState = 3
      this.onclose?.({ code: 1000, reason: '' })
    }
    get bytes() { return Buffer.concat(this.audio) }
  }
  const noOp = () => {}
  const runningUi = {
    setStatus: (kind, text) => statuses.push({ kind, text }), setDebug: noOp, setPaused: noOp,
    setOriginalMirror: noOp, setTranslationMirror: noOp,
  }
  const replacements = {
    '@evenrealities/even_hub_sdk': {
      waitForEvenAppBridge: async () => bridge,
      TextContainerProperty: Property,
      CreateStartUpPageContainer: Property,
      RebuildPageContainer: Property,
      OsEventTypeList: {
        CLICK_EVENT: 0, SCROLL_TOP_EVENT: 1, SCROLL_BOTTOM_EVENT: 2,
        DOUBLE_CLICK_EVENT: 3, SYSTEM_EXIT_EVENT: 4, ABNORMAL_EXIT_EVENT: 5,
      },
    },
    './ui': {
      mountUi(value) {
        callbacks = value
        return {
          applyConfig: noOp, showConnecting: noOp,
          showStartError(message) { throw new Error(message) },
          showRunning: () => runningUi,
        }
      },
      getSelectedModel: () => null,
    },
    './render': {
      createWriteQueue: () => ({ current: Promise.resolve() }),
      createContainerRenderer: () => ({ schedule: noOp, flush: () => Promise.resolve(), cancel: noOp, reset: noOp, setBox: noOp }),
      fitTail: value => value,
    },
  }
  const context = vm.createContext({
    console, Uint8Array, URLSearchParams, WebSocket: Socket,
    Date: class extends Date { static now() { return now } },
    location: { search: '' }, window: { addEventListener: noOp },
    setTimeout(callback, delay) {
      const id = ++nextTimer
      timers.set(id, { at: now + delay, callback })
      return id
    },
    clearTimeout: id => timers.delete(id),
    setInterval(callback, interval) {
      const id = ++nextTimer
      timers.set(id, { at: now + interval, callback, interval })
      return id
    },
    clearInterval: id => timers.delete(id),
  })
  const modules = new Map()
  function load(filename) {
    if (filename.endsWith('.json')) return JSON.parse(fs.readFileSync(filename, 'utf8'))
    if (modules.has(filename)) return modules.get(filename).exports
    if (!compiled.has(filename)) {
      compiled.set(filename, ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText)
    }
    const module = { exports: {} }
    modules.set(filename, module)
    const requireModule = name => {
      if (Object.hasOwn(replacements, name)) return replacements[name]
      assert.ok(name.startsWith('.'), `Unexpected external dependency: ${name}`)
      return load(path.resolve(path.dirname(filename), name.endsWith('.json') ? name : `${name}.ts`))
    }
    vm.runInContext(`(function(require, module, exports) {\n${compiled.get(filename)}\n})`, context, { filename })(
      requireModule, module, module.exports,
    )
    return module.exports
  }
  load(path.resolve(__dirname, '../src/main.ts'))
  const starting = callbacks.onStart(['en', 'de'], 'zh-Hans', 'Chinese (Simplified)', {
    sonioxKey: 'test-only', relayUrl: 'https://example.invalid', screenClearSeconds: 15,
    model: { id: 'test', label: 'Test', name: 'test', url: 'https://example.invalid', key: 'test-model-key' },
  })
  await settle()
  await sockets[0].open()
  await starting
  const app = {
    sockets, callbacks, statuses,
    logs: () => load(path.resolve(__dirname, '../src/diagnostics.ts')).diagnostics.exportText(),
    advance,
    frame(amplitude) {
      advance(100)
      onEvent({ audioEvent: { audioPcm: pcm(amplitude) } })
    },
    idle() {
      app.advance(16_000)
      app.frame(300)
      assert.equal(sockets.at(-1).readyState, 3)
    },
  }
  return app
}

test('idle wake requires a stronger onset than the connected audio send gate', async () => {
  const app = await startApp()
  app.frame(600)
  assertAudio(app.sockets[0].bytes, [600])
  app.idle()
  app.frame(600)
  assert.equal(app.sockets.length, 1, 'Quiet audio must respect the idle wake floor')
  app.frame(1200)
  assert.equal(app.sockets.length, 2)
  await app.sockets[1].open()
  assertAudio(app.sockets[1].bytes, [300, 600, 1200])
})

test('speech at the idle deadline reaches the new socket with its quiet continuation', async () => {
  const app = await startApp()
  app.advance(15_000)
  for (const amplitude of [1200, 220, 210]) app.frame(amplitude)
  assert.equal(app.sockets.length, 2, 'The onset must request a new stream immediately')
  assertAudio(app.sockets[0].bytes, [])
  await app.sockets[1].open()
  assertAudio(app.sockets[1].bytes, [1200, 220, 210])
})

test('a quiet onset at the idle deadline remains in the next wake pre-roll', async () => {
  const app = await startApp()
  app.advance(15_000)
  for (const amplitude of [320, 1200, 220]) app.frame(amplitude)
  assert.equal(app.sockets.length, 2)
  await app.sockets[1].open()
  assertAudio(app.sockets[1].bytes, [320, 1200, 220])
})

test('replays quiet onset and every handshake frame in their original order', async () => {
  const app = await startApp()
  app.idle()
  for (const amplitude of [320, 330, 340, 1200, 220, 210]) app.frame(amplitude)
  assert.equal(app.sockets.length, 2)
  await app.sockets[1].open()
  assertAudio(app.sockets[1].bytes, [300, 320, 330, 340, 1200, 220, 210])
})

test('keeps forwarding quiet syllables immediately after the socket wakes', async () => {
  const app = await startApp()
  app.idle()
  app.frame(1200)
  await app.sockets[1].open()
  app.frame(200)
  app.advance(2200)
  app.frame(200)
  assertAudio(app.sockets[1].bytes, [300, 1200, 200, 200])
})

test('room noise does not wake a session and only the recent 800 ms precedes speech', async () => {
  const app = await startApp()
  app.idle()
  for (let i = 0; i < 40; i++) app.frame(300)
  assert.equal(app.sockets.length, 1)
  app.frame(1200)
  await app.sockets[1].open()
  assertAudio(app.sockets[1].bytes, [300, 300, 300, 300, 300, 300, 300, 300, 1200])
})

test('cooldown defers reconnecting without removing the softer parts of speech', async () => {
  const app = await startApp()
  app.idle()
  app.frame(1200)
  await app.sockets[1].open()
  app.advance(5100)
  app.frame(300)
  assert.equal(app.sockets[1].readyState, 3)
  for (const amplitude of [1200, 260, 280]) app.frame(amplitude)
  assert.equal(app.sockets.length, 2)
  app.advance(2100)
  app.frame(200)
  assert.equal(app.sockets.length, 3)
  await app.sockets[2].open()
  assertAudio(app.sockets[2].bytes, [300, 1200, 260, 280, 200])
})

test('speech at the wake verification deadline survives cooldown and still triggers a wake', async () => {
  const app = await startApp()
  app.idle()
  app.frame(1200)
  await app.sockets[1].open()
  const previousAudio = app.sockets[1].bytes
  app.advance(5000)
  for (const amplitude of [1200, 220, 210]) app.frame(amplitude)
  assert.equal(app.sockets[1].readyState, 3)
  assert.equal(app.sockets.length, 2, 'Keep the noise cooldown before reconnecting')
  assert.ok(app.sockets[1].bytes.equals(previousAudio), 'New speech must not go to the retired stream')
  app.advance(2000)
  app.frame(200)
  assert.equal(app.sockets.length, 3, 'The buffered onset must wake even when later frames are quiet')
  await app.sockets[2].open()
  assertAudio(app.sockets[2].bytes, [1200, 220, 210, 200])
})

test('pause discards pending audio and a late wake cannot replace the resumed socket', async () => {
  const app = await startApp()
  app.idle()
  app.frame(1200)
  const oldWake = app.sockets[1]
  app.callbacks.onPause()
  const resuming = app.callbacks.onResume()
  await app.sockets[2].open()
  await resuming
  await oldWake.open()
  assert.equal(oldWake.readyState, 3)
  assert.equal(oldWake.bytes.length, 0)
  app.frame(1200)
  assertAudio(app.sockets[2].bytes, [1200])
})

test('a stale wake completion cannot clear audio belonging to a newer wake', async () => {
  const app = await startApp()
  app.idle()
  app.frame(1200)
  const oldWake = app.sockets[1]
  app.callbacks.onPause()
  const resuming = app.callbacks.onResume()
  await app.sockets[2].open()
  await resuming
  app.idle()
  app.frame(1200)
  await oldWake.open()
  app.frame(200)
  assert.equal(app.sockets.length, 4)
  await app.sockets[3].open()
  assertAudio(app.sockets[3].bytes, [300, 1200, 200])
})

test('a pre-pause handshake failure cannot reconnect the healthy resumed socket', async () => {
  const app = await startApp()
  app.idle()
  app.frame(1200)
  const oldWake = app.sockets[1]
  app.callbacks.onPause()
  const resuming = app.callbacks.onResume()
  await app.sockets[2].open()
  await resuming
  await oldWake.fail()
  app.advance(1600)
  await settle()
  assert.equal(app.sockets[2].readyState, 1)
  assert.equal(app.sockets.length, 3)
  app.frame(1200)
  assertAudio(app.sockets[2].bytes, [1200])
})

test('a stalled handshake retains at most ten seconds of the newest audio', async () => {
  const app = await startApp()
  app.idle()
  app.frame(1200)
  for (let i = 0; i < 120; i++) app.frame(300)
  await app.sockets[1].open()
  assert.equal(app.sockets[1].bytes.length, 320_000)
  assertAudio(app.sockets[1].bytes, Array(100).fill(300))
})

test('idle disconnect still runs when the microphone stops delivering frames', async () => {
  const app = await startApp()
  app.advance(16_000)
  assert.equal(app.sockets[0].readyState, 3, 'Silence must retire the paid stream without a new PCM frame')
  app.advance(60_000)
  assert.equal(app.sockets.length, 1, 'Do not reconnect during silence')
  app.frame(1200)
  assert.equal(app.sockets.length, 2)
  await app.sockets[1].open()
  assertAudio(app.sockets[1].bytes, [1200])
})

test('one diagnostic timeline shows microphone frames, gating, idle and manual recovery', async () => {
  const app = await startApp()
  app.frame(300)
  app.frame(1200)
  app.idle()
  app.callbacks.onPause()
  const resuming = app.callbacks.onResume()
  await app.sockets.at(-1).open()
  await resuming
  const text = app.logs()
  assert.match(text, /"mic.frames":3/)
  assert.match(text, /"stt.sentBytes":3200/)
  assert.match(text, /stt.idle/)
  assert.match(text, /session.pause/)
  assert.match(text, /session.resume/)
})

test('speech can recover after more than three consecutive request timeouts', async () => {
  const app = await startApp()
  for (let i = 0; i < 7; i++) {
    app.sockets.at(-1).serverError('REQUEST_TIMEOUT')
    app.advance(31_000)
    await settle()
    assert.equal(app.sockets.length, i + 1, 'Errors must not reopen a paid stream without audio')
    app.frame(1200)
    assert.equal(app.sockets.length, i + 2, 'Transient failures must never permanently disable speech wake')
    await app.sockets.at(-1).open()
    assert.ok(app.sockets.at(-1).bytes.length > 0)
  }
})

test('empty responses do not reset the reconnect backoff', async () => {
  const app = await startApp()
  app.sockets[0].serverError('request_timeout')
  app.advance(1500)
  app.frame(1200)
  await app.sockets[1].open()
  app.sockets[1].receive({ tokens: [] })
  app.sockets[1].serverError('request_timeout')
  app.advance(1500)
  app.frame(1200)
  assert.equal(app.sockets.length, 2, 'A second failure must wait longer even after an empty response')
  app.advance(1500)
  app.frame(200)
  assert.equal(app.sockets.length, 3, 'Buffered speech must survive the backoff')
  await app.sockets[2].open()
  assertAudio(app.sockets[2].bytes, [1200, 200])
})

test('an invalid key stops automatic retries and preserves the error status', async () => {
  const app = await startApp()
  app.sockets[0].serverError('unauthenticated', 401)
  for (let i = 0; i < 5; i++) {
    app.advance(31_000)
    app.frame(1200)
    await settle()
  }
  assert.equal(app.sockets.length, 1)
  assert.equal(app.statuses.at(-1).kind, 'error')
})

test('a stalled wake handshake expires and later speech can try again', async () => {
  const app = await startApp()
  app.idle()
  app.frame(1200)
  const stalled = app.sockets[1]
  app.advance(21_000)
  await settle()
  assert.equal(stalled.readyState, 3, 'A handshake cannot own waking forever')
  app.advance(31_000)
  app.frame(1200)
  assert.equal(app.sockets.length, 3)
  await app.sockets[2].open()
  assert.ok(app.sockets[2].bytes.length > 0)
})

test('an unexpected normal server close can recover on speech', async () => {
  const app = await startApp()
  app.sockets[0].readyState = 3
  app.sockets[0].onclose({ code: 1000, reason: '' })
  app.advance(1600)
  app.frame(1200)
  assert.equal(app.sockets.length, 2)
  await app.sockets[1].open()
  assertAudio(app.sockets[1].bytes, [1200])
})

test('pausing during error backoff prevents microphone frames from reopening a stream', async () => {
  const app = await startApp()
  app.sockets[0].serverError('request_timeout')
  app.callbacks.onPause()
  app.advance(31_000)
  app.frame(1200)
  assert.equal(app.sockets.length, 1)
  const resuming = app.callbacks.onResume()
  await app.sockets[1].open()
  await resuming
  app.frame(1200)
  assertAudio(app.sockets[1].bytes, [1200])
})

test('a short phrase survives the longest retry backoff before a prompt handshake', async () => {
  const app = await startApp()
  for (let i = 0; i < 6; i++) {
    app.sockets.at(-1).serverError('request_timeout')
    app.advance(31_000)
    app.frame(1200)
    await app.sockets.at(-1).open()
  }
  app.sockets.at(-1).serverError('request_timeout')
  const count = app.sockets.length
  app.frame(1200)
  for (let i = 0; i < 350 && app.sockets.length === count; i++) app.frame(300)
  assert.equal(app.sockets.length, count + 1)
  await app.sockets.at(-1).open()
  assert.ok(app.sockets.at(-1).bytes.includes(pcm(1200)), 'Scheduled backoff must not discard the entire short phrase')
})

test('an invalid key received during page creation remains visible and blocks speech retries', async () => {
  const app = await startApp({ startupError: 'unauthenticated' })
  assert.equal(app.statuses.at(-1)?.kind, 'error')
  assert.match(app.statuses.at(-1).text, /unauthenticated/)
  for (let i = 0; i < 5; i++) {
    app.advance(31_000)
    app.frame(1200)
  }
  assert.equal(app.sockets.length, 1)
})
