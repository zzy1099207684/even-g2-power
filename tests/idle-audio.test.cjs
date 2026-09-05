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
async function startApp() {
  let now = 100_000
  let callbacks
  let onEvent
  const sockets = []
  const timers = new Map()
  let nextTimer = 0
  function advance(ms) {
    now += ms
    for (const [id, timer] of timers) {
      if (timer.at > now) continue
      timers.delete(id)
      timer.callback()
    }
  }
  const bridge = {
    getLocalStorage: async () => null,
    createStartUpPageContainer: async () => 0,
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
      this.onerror(new Error('Test handshake failure'))
      await settle()
    }
    get bytes() { return Buffer.concat(this.audio) }
  }
  const noOp = () => {}
  const runningUi = {
    setStatus: noOp, setDebug: noOp, setPaused: noOp,
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
    setInterval: () => 1, clearInterval: noOp,
  })
  const modules = new Map()
  function load(filename) {
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
      return load(path.resolve(path.dirname(filename), `${name}.ts`))
    }
    vm.runInContext(`(function(require, module, exports) {\n${compiled.get(filename)}\n})`, context, { filename })(
      requireModule, module, module.exports,
    )
    return module.exports
  }
  load(path.resolve(__dirname, '../src/main.ts'))
  const starting = callbacks.onStart(['en', 'de'], 'zh-Hans', 'Chinese (Simplified)', {
    sonioxKey: 'test-only', relayUrl: 'https://example.invalid', screenClearSeconds: 15,
  })
  await settle()
  await sockets[0].open()
  await starting
  const app = {
    sockets, callbacks,
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

test('ordinary audio that was sent while connected also wakes an idle session', async () => {
  const app = await startApp()
  app.frame(600)
  assertAudio(app.sockets[0].bytes, [600])
  app.idle()
  app.frame(600)
  assert.equal(app.sockets.length, 2)
  await app.sockets[1].open()
  assertAudio(app.sockets[1].bytes, [600])
})

test('replays quiet onset and every handshake frame in their original order', async () => {
  const app = await startApp()
  app.idle()
  for (const amplitude of [320, 330, 340, 1000, 220, 210]) app.frame(amplitude)
  assert.equal(app.sockets.length, 2)
  await app.sockets[1].open()
  assertAudio(app.sockets[1].bytes, [320, 330, 340, 1000, 220, 210])
})

test('keeps forwarding quiet syllables immediately after the socket wakes', async () => {
  const app = await startApp()
  app.idle()
  app.frame(1000)
  await app.sockets[1].open()
  app.frame(200)
  app.advance(2200)
  app.frame(200)
  assertAudio(app.sockets[1].bytes, [1000, 200, 200])
})

test('room noise does not wake a session and only the recent 800 ms precedes speech', async () => {
  const app = await startApp()
  app.idle()
  for (let i = 0; i < 40; i++) app.frame(300)
  assert.equal(app.sockets.length, 1)
  app.frame(1000)
  await app.sockets[1].open()
  assertAudio(app.sockets[1].bytes, [300, 300, 300, 300, 300, 300, 300, 300, 1000])
})

test('cooldown defers reconnecting without removing the softer parts of speech', async () => {
  const app = await startApp()
  app.idle()
  app.frame(1000)
  await app.sockets[1].open()
  app.advance(5100)
  app.frame(300)
  assert.equal(app.sockets[1].readyState, 3)
  for (const amplitude of [1000, 260, 280]) app.frame(amplitude)
  assert.equal(app.sockets.length, 2)
  app.advance(2100)
  app.frame(200)
  assert.equal(app.sockets.length, 3)
  await app.sockets[2].open()
  assertAudio(app.sockets[2].bytes, [1000, 260, 280, 200])
})

test('pause discards pending audio and a late wake cannot replace the resumed socket', async () => {
  const app = await startApp()
  app.idle()
  app.frame(1000)
  const oldWake = app.sockets[1]
  app.callbacks.onPause()
  const resuming = app.callbacks.onResume()
  await app.sockets[2].open()
  await resuming
  await oldWake.open()
  assert.equal(oldWake.readyState, 3)
  assert.equal(oldWake.bytes.length, 0)
  app.frame(1000)
  assertAudio(app.sockets[2].bytes, [1000])
})

test('a stale wake completion cannot clear audio belonging to a newer wake', async () => {
  const app = await startApp()
  app.idle()
  app.frame(1000)
  const oldWake = app.sockets[1]
  app.callbacks.onPause()
  const resuming = app.callbacks.onResume()
  await app.sockets[2].open()
  await resuming
  app.idle()
  app.frame(1000)
  await oldWake.open()
  app.frame(200)
  assert.equal(app.sockets.length, 4)
  await app.sockets[3].open()
  assertAudio(app.sockets[3].bytes, [1000, 200])
})

test('a pre-pause handshake failure cannot reconnect the healthy resumed socket', async () => {
  const app = await startApp()
  app.idle()
  app.frame(1000)
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
  app.frame(1000)
  assertAudio(app.sockets[2].bytes, [1000])
})

test('a stalled handshake retains at most ten seconds of the newest audio', async () => {
  const app = await startApp()
  app.idle()
  app.frame(1000)
  for (let i = 0; i < 120; i++) app.frame(300)
  await app.sockets[1].open()
  assert.equal(app.sockets[1].bytes.length, 320_000)
  assertAudio(app.sockets[1].bytes, Array(100).fill(300))
})
