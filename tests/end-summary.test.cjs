const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')
const settle = () => new Promise(resolve => setImmediate(resolve))
const compiled = new Map()

// Exercise main, transcript, history, config and the summary client together.
// Only the device, speech provider, network and rendered UI are external boundaries.
function appHarness() {
  const storage = new Map()
  const screens = []
  const requests = []
  const shutdowns = []
  const microphone = []
  const timers = new Map()
  let callbacks, speech, onEvent
  let nextSpeech
  let creates = 0, rebuilds = 0, closes = 0
  const model = { id: 'test', label: 'Test', name: 'test-model', url: 'https://model.invalid/chat/completions', key: 'test-only' }
  const bridge = {
    getLocalStorage: async key => storage.get(key) ?? '',
    setLocalStorage: async (key, value) => { storage.set(key, value); return true },
    createStartUpPageContainer: async () => ++creates === 1 ? 0 : 1,
    rebuildPageContainer: async () => { rebuilds++; return true },
    audioControl: async enabled => { microphone.push(enabled); return true },
    shutDownPageContainer: async mode => { shutdowns.push(mode); return true },
    onEvenHubEvent(handler) { onEvent = handler; return () => { onEvent = null } },
  }
  const noOp = () => {}
  class Property { constructor(value) { Object.assign(this, value) } }
  const replacements = {
    '@evenrealities/even_hub_sdk': {
      waitForEvenAppBridge: async () => bridge,
      TextContainerProperty: Property, CreateStartUpPageContainer: Property, RebuildPageContainer: Property,
      OsEventTypeList: { CLICK_EVENT: 0, SCROLL_TOP_EVENT: 1, SCROLL_BOTTOM_EVENT: 2, DOUBLE_CLICK_EVENT: 3, SYSTEM_EXIT_EVENT: 4, ABNORMAL_EXIT_EVENT: 5 },
    },
    './asr/stt': { startSonioxStream: async options => {
      speech = options
      if (nextSpeech) {
        const pending = nextSpeech
        nextSpeech = null
        return pending
      }
      return { sendPcm: noOp, close() { closes++ } }
    } },
    './ui': {
      getSelectedModel: () => model,
      mountUi(value) {
        callbacks = value
        return {
          applyConfig: noOp,
          showConnecting: () => screens.push('connecting'),
          showEnding: () => screens.push('ending'),
          showHome: message => screens.push({ home: true, message }),
          showStartError: message => screens.push({ error: message }),
          showRunning() {
            screens.push('running')
            return { setStatus: noOp, setDebug: noOp, setPaused: noOp, setOriginalMirror: noOp, setTranslationMirror: noOp }
          },
        }
      },
    },
    './render': {
      createWriteQueue: () => ({ current: Promise.resolve() }),
      createContainerRenderer: () => ({ schedule: noOp, flush: () => Promise.resolve(), cancel: noOp, reset: noOp, setBox: noOp }),
      fitTail: value => value,
    },
  }
  const context = vm.createContext({
    console: { ...console, error: noOp }, AbortController, Request, Response, URLSearchParams, Uint8Array,
    location: { search: '' }, window: { addEventListener: noOp },
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id },
    clearTimeout: id => timers.delete(id), setInterval: () => 1, clearInterval: noOp,
    fetch(url, init) {
      return new Promise((resolve, reject) => {
        requests.push({ url, body: JSON.parse(init.body), resolve, reject })
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    },
  })
  const modules = new Map()
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename).exports
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText)
    const module = { exports: {} }
    modules.set(filename, module)
    const requireModule = name => Object.hasOwn(replacements, name)
      ? replacements[name] : load(path.resolve(path.dirname(filename), `${name}.ts`))
    vm.runInContext(`(function(require,module,exports){${compiled.get(filename)}\n})`, context)(requireModule, module, module.exports)
    return module.exports
  }
  load(path.resolve(__dirname, '../src/main.ts'))
  return {
    screens, requests, shutdowns, microphone, storage, bridge,
    start: enabled => callbacks.onStart(['en'], 'zh-Hans', 'Chinese (Simplified)', {
      relayUrl: 'https://relay.invalid', sonioxKey: 'test-only', model, screenClearSeconds: 15, summaryEnabled: enabled,
    }),
    draft(text) { speech.onLive(text, Array.from(text, () => 'en')) },
    end: () => callbacks.onEnd(),
    pause: () => callbacks.onPause(),
    resume: () => callbacks.onResume(),
    deferSpeech() {
      let resolve
      nextSpeech = new Promise(done => { resolve = done })
      return () => resolve({ sendPcm: noOp, close() { closes++ } })
    },
    event: event => onEvent?.(event),
    records: () => JSON.parse(storage.get('g2-translate-history') ?? '[]'),
    counts: () => ({ creates, rebuilds, closes }),
    expire: () => { for (const fn of [...timers.values()]) fn() },
  }
}

test('End saves original without a completed translation, waits for summary, then returns home once', async () => {
  const app = appHarness()
  await app.start(true)
  app.draft('Friday meeting with Alice sending the notes')
  const ending = app.end()
  await app.end()
  await settle()
  assert.equal(app.records().length, 1, 'Raw transcript must be durable before the model responds')
  assert.equal(app.records()[0].translation, '')
  assert.equal(app.screens.at(-1), 'ending')
  assert.equal(app.microphone.at(-1), false)
  assert.equal(app.counts().closes, 1)
  assert.equal(app.requests.length, 1)
  assert.equal(app.requests[0].url, 'https://relay.invalid/summary')
  assert.equal(app.requests[0].body.text, 'Friday meeting with Alice sending the notes')
  assert.equal(app.requests[0].body.targetLang, 'Chinese (Simplified)')
  app.requests[0].resolve(Response.json({ choices: [{ message: { content: '周五开会. Alice 发送纪要.' } }] }))
  await ending
  assert.equal(app.records()[0].summary, '周五开会. Alice 发送纪要.')
  assert.equal(app.screens.at(-1).home, true)
  assert.deepEqual(app.shutdowns, [])
})

test('End with summary disabled returns home without a model request and supports another session', async () => {
  const app = appHarness()
  await app.start(false)
  app.draft('First session')
  await app.end()
  assert.equal(app.screens.at(-1).home, true)
  assert.equal(app.requests.length, 0)
  assert.equal(app.records()[0].original, 'First session')
  await app.start(false)
  app.draft('Second session')
  await app.end()
  assert.deepEqual(app.records().map(r => r.original), ['Second session', 'First session'])
  assert.equal(app.counts().creates, 1)
  assert.ok(app.counts().rebuilds >= 1)
  assert.deepEqual(app.shutdowns, [])
  app.event({ textEvent: { eventType: 3 } })
  assert.deepEqual(app.shutdowns, [1], 'Double tap must still exit on the home screen')
})

test('Summary failure keeps the raw record and stops the loading screen', async () => {
  const app = appHarness()
  await app.start(true)
  app.draft('Keep this even if the model fails')
  const ending = app.end()
  await settle()
  assert.equal(app.requests.length, 1)
  app.requests[0].resolve(new Response('provider unavailable', { status: 503 }))
  await ending
  assert.equal(app.records()[0].original, 'Keep this even if the model fails')
  assert.equal(app.records()[0].summary, undefined)
  assert.equal(app.screens.at(-1).home, true)
  assert.ok(app.screens.at(-1).message)
})

test('Empty session skips both summary and archive', async () => {
  const app = appHarness()
  await app.start(true)
  await app.end()
  assert.equal(app.records().length, 0)
  assert.equal(app.requests.length, 0)
  assert.equal(app.screens.at(-1).home, true)
})

test('Summary timeout preserves the saved transcript and returns home', async () => {
  const app = appHarness()
  await app.start(true)
  app.draft('A long-running summary')
  const ending = app.end()
  await settle()
  assert.equal(app.requests.length, 1)
  app.expire()
  await ending
  assert.equal(app.records().length, 1)
  assert.equal(app.screens.at(-1).home, true)
  assert.ok(app.screens.at(-1).message)
})

test('A failed archive write is reported without requesting a summary', async () => {
  const app = appHarness()
  await app.start(true)
  app.draft('Do not silently lose this')
  app.bridge.setLocalStorage = async () => false
  await app.end()
  assert.equal(app.requests.length, 0)
  assert.equal(app.screens.at(-1).home, true)
  assert.ok(app.screens.at(-1).message)
})

test('End while Resume is connecting cannot reopen the microphone after returning home', async () => {
  const app = appHarness()
  await app.start(false)
  app.draft('Save this session')
  app.pause()
  const connected = app.deferSpeech()
  const resuming = app.resume()
  await app.end()
  connected()
  await resuming
  assert.equal(app.screens.at(-1).home, true)
  assert.equal(app.microphone.at(-1), false)
  assert.equal(app.counts().closes, 2, 'The late connection must be closed as well')
})

test('A real exit during generation cancels the request and keeps the already saved original', async () => {
  const app = appHarness()
  await app.start(true)
  app.draft('Keep this before exiting')
  const ending = app.end()
  await settle()
  assert.equal(app.requests.length, 1)
  app.event({ sysEvent: { eventType: 4 } })
  await ending
  assert.equal(app.records()[0].original, 'Keep this before exiting')
  assert.equal(app.screens.at(-1), 'ending', 'An exited app must not navigate back to home')
})
