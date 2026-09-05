const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')

const settle = () => new Promise(resolve => setImmediate(resolve))
const compiled = new Map()

// Run the actual translator and transcript. Only the network and clock are
// controlled: real response streams exercise SSE decoding and cancellation.
function startSession(t) {
  let now = 100_000
  let contextText = 'Earlier conversation.'
  const timers = new Map()
  let timerId = 0
  const requests = []
  const commits = []
  const previews = []
  const errors = []
  const context = vm.createContext({
    AbortController, TextDecoder, console,
    Date: class extends Date { static now() { return now } },
    setTimeout(callback, delay) {
      const id = ++timerId
      timers.set(id, { at: now + delay, callback })
      return id
    },
    clearTimeout: id => timers.delete(id),
    fetch(url, init) {
      assert.equal(url, 'https://relay.invalid/translate')
      return new Promise((resolve, reject) => {
        let controller
        let closed = false
        const stream = new ReadableStream({
          start(value) { controller = value },
          cancel() { closed = true },
        })
        const request = {
          body: JSON.parse(init.body),
          signal: init.signal,
          respond(status = 200) {
            resolve(new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } }))
          },
          chunk(text) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`))
          },
          finish() {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
            controller.close()
            closed = true
          },
          fail() {
            controller.error(new Error('Connection interrupted'))
            closed = true
          },
        }
        init.signal.addEventListener('abort', () => {
          const error = new DOMException('Aborted', 'AbortError')
          if (!closed) controller.error(error)
          closed = true
          reject(error)
        }, { once: true })
        requests.push(request)
      })
    },
  })
  function load(name) {
    const filename = path.resolve(__dirname, `../src/${name}.ts`)
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText)
    const module = { exports: {} }
    vm.runInContext(`(function(module, exports) { ${compiled.get(filename)}\n})`, context)(module, module.exports)
    return module.exports
  }
  const transcript = load('transcript').createTranscript()
  const session = load('translate').createTranslationSession(
    'https://relay.invalid', 'Chinese',
    (text, passthrough) => {
      commits.push({ text, passthrough })
      transcript.commitTranslation(text)
    },
    error => errors.push(error.message),
    () => contextText,
    () => ({ url: 'https://model.invalid', name: 'test', key: 'test-only' }),
    text => {
      previews.push(text)
      transcript.updateCurrentTranslation(text)
    },
  )
  t.after(() => session.dispose())
  return {
    requests, commits, previews, errors, transcript, session,
    setContext(text) { contextText = text },
    submit(text, passthrough = false) {
      transcript.commitOriginal(text)
      session.submitFinal(text, passthrough)
    },
    async advance(ms) {
      now += ms
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= now)
        if (!due.length) break
        for (const [id, timer] of due) {
          if (!timers.delete(id)) continue
          timer.callback()
        }
        await settle()
      }
    },
  }
}

test('shows streamed translation before completion and archives it only once when final', async t => {
  const app = startSession(t)
  app.submit('First sentence.')
  app.requests[0].respond()
  app.requests[0].chunk('第一')
  await settle()
  assert.equal(app.transcript.getGlassesTranslation(), '第一')
  assert.equal(app.transcript.getCurrentTranslation(), '第一')
  assert.equal(app.transcript.getFullTranslation(), '')
  assert.equal(app.commits.length, 0)
  app.requests[0].chunk('句话.')
  app.requests[0].finish()
  await settle()
  assert.equal(app.transcript.getGlassesTranslation(), '第一句话.')
  assert.equal(app.transcript.getFullTranslation(), '第一句话.')
  assert.equal(app.transcript.getCurrentTranslation(), '')
  assert.equal(app.commits.length, 1)
})

test('overlaps requests but publishes completed sentences in speech order', async t => {
  const app = startSession(t)
  app.submit('First.')
  app.submit('Second.')
  app.submit('Third.')
  app.submit('Fourth.')
  assert.equal(app.requests.length, 3, 'Three sentences start together; the fourth waits for a free slot')
  app.requests[2].respond()
  app.requests[2].chunk('第三句.')
  app.requests[2].finish()
  await settle()
  assert.equal(app.requests.length, 4, 'A freed slot starts the fourth sentence while earlier ones are still running')
  assert.equal(app.requests[3].body.text, 'Fourth.')
  app.requests[3].respond()
  app.requests[3].chunk('第四句.')
  app.requests[3].finish()
  app.requests[1].respond()
  app.requests[1].chunk('第二句.')
  app.requests[1].finish()
  await settle()
  assert.equal(app.commits.length, 0, 'Faster later sentences must not overtake the first')
  assert.equal(app.transcript.getGlassesTranslation(), '')
  app.requests[0].respond()
  app.requests[0].chunk('第一句.')
  app.requests[0].finish()
  await settle()
  assert.deepEqual(app.commits.map(entry => entry.text), ['第一句.', '第二句.', '第三句.', '第四句.'])
  assert.equal(app.transcript.getFullTranslation(), '第一句.\n第二句.\n第三句.\n第四句.')
})

test('reveals the next sentence draft as soon as its predecessor commits', async t => {
  const app = startSession(t)
  app.submit('First.')
  app.submit('Second.')
  assert.equal(app.requests.length, 2)
  app.requests[1].respond()
  app.requests[1].chunk('下一句')
  await settle()
  assert.equal(app.transcript.getGlassesTranslation(), '')
  app.requests[0].respond()
  app.requests[0].chunk('第一句.')
  app.requests[0].finish()
  await settle()
  assert.equal(app.transcript.getGlassesTranslation(), '第一句.\n下一句')
  assert.equal(app.transcript.getFullTranslation(), '第一句.')
  app.transcript.scrollOlder()
  assert.equal(app.transcript.getGlassesTranslation(), '第一句.', 'History contains only paired final segments')
  app.transcript.cutLiveView()
  app.transcript.scrollNewer()
  assert.equal(app.transcript.getGlassesTranslation(), '')
  assert.equal(app.transcript.getFullTranslation(), '第一句.')
})

test('queued sentences retain their own preceding context', async t => {
  const app = startSession(t)
  app.submit('First.')
  app.submit('Second.')
  app.submit('Third.')
  app.setContext('First. Second. Third.')
  app.submit('Fourth.')
  assert.equal(app.requests.length, 3)
  app.setContext('First. Second. Third. Fourth. Future sentence.')
  app.requests[0].respond()
  app.requests[0].chunk('第一句.')
  app.requests[0].finish()
  await settle()
  const fourth = app.requests.find(request => request.body.text === 'Fourth.')
  assert.ok(fourth, 'Queued work starts when a request slot becomes available')
  assert.equal(fourth.body.context, 'First. Second. Third.')
})

test('same-language speech skips the model without overtaking pending translations', async t => {
  const app = startSession(t)
  app.submit('First.')
  app.submit('这句无需翻译.', true)
  app.submit('Third.')
  assert.deepEqual(app.requests.map(request => request.body.text), ['First.', 'Third.'])
  assert.equal(app.commits.length, 0)
  app.requests[0].respond()
  app.requests[0].chunk('第一句.')
  app.requests[0].finish()
  await settle()
  assert.deepEqual(app.commits, [
    { text: '第一句.', passthrough: false },
    { text: '这句无需翻译.', passthrough: true },
  ])
})

test('a failed stream clears its draft and retries without archiving partial text', async t => {
  const app = startSession(t)
  app.submit('First.')
  app.requests[0].respond()
  app.requests[0].chunk('未完成')
  await settle()
  assert.equal(app.transcript.getGlassesTranslation(), '未完成')
  app.requests[0].fail()
  await settle()
  assert.equal(app.transcript.getGlassesTranslation(), '')
  assert.equal(app.transcript.getFullTranslation(), '')
  await app.advance(800)
  assert.equal(app.requests.length, 2)
  app.requests[1].respond()
  app.requests[1].chunk('完整译文.')
  app.requests[1].finish()
  await settle()
  assert.equal(app.transcript.getFullTranslation(), '完整译文.')
  assert.equal(app.commits.length, 1)
})

test('rate limiting pauses new requests and reduces concurrent retries', async t => {
  const app = startSession(t)
  app.submit('First.')
  app.submit('Second.')
  app.submit('Third.')
  app.submit('Fourth.')
  assert.equal(app.requests.length, 3)
  app.requests[0].respond(429)
  app.requests[1].respond(429)
  app.requests[2].respond(429)
  await settle()
  await app.advance(999)
  assert.equal(app.requests.length, 3)
  await app.advance(1)
  assert.equal(app.requests.length, 4, 'Only one retry may run after rate limiting')
  assert.equal(app.requests[3].body.text, 'First.')
  app.requests[3].respond()
  app.requests[3].chunk('第一句.')
  app.requests[3].finish()
  await settle()
  assert.equal(app.requests.length, 5)
  assert.equal(app.requests[4].body.text, 'Second.')
})

test('dispose aborts all in-flight work and prevents later output or retries', async t => {
  const app = startSession(t)
  app.submit('First.')
  app.submit('Second.')
  app.submit('Third.')
  app.submit('Fourth.')
  assert.equal(app.requests.length, 3)
  for (const request of app.requests) request.respond()
  app.requests[0].chunk('部分')
  await settle()
  const previews = [...app.previews]
  app.session.dispose()
  await settle()
  await app.advance(30_000)
  assert.ok(app.requests.every(request => request.signal.aborted))
  assert.deepEqual(app.previews, previews)
  assert.equal(app.commits.length, 0)
  assert.equal(app.requests.length, 3)
})

test('an overloaded queue keeps original fallback sentences in their correct positions', async t => {
  const app = startSession(t)
  for (let i = 1; i <= 13; i++) app.submit(`Sentence ${i}.`)
  assert.equal(app.requests.length, 3)
  for (let i = 0; i < app.requests.length; i++) {
    const request = app.requests[i]
    request.respond()
    request.chunk(`译文 ${request.body.text}`)
    request.finish()
    await settle()
  }
  assert.equal(app.commits.length, 13)
  assert.deepEqual(app.commits.slice(0, 6).map(entry => entry.text), [
    '译文 Sentence 1.', '译文 Sentence 2.', '译文 Sentence 3.', 'Sentence 4.', 'Sentence 5.', '译文 Sentence 6.',
  ])
})

test('ending the app stops translation before waiting for history storage', async t => {
  const app = startSession(t)
  app.submit('Finished original.')
  app.requests[0].respond()
  app.requests[0].chunk('已完成.')
  app.requests[0].finish()
  await settle()
  app.submit('Still translating.')
  app.requests[1].respond()
  app.requests[1].chunk('未完成')
  await settle()

  let finishStorage
  let archived
  let exited = false
  const filename = path.resolve(__dirname, '../src/main.ts')
  const source = fs.readFileSync(filename, 'utf8')
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true)
  const end = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'endSession')
  const code = ts.transpileModule(end.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const context = vm.createContext({
    console, transcript: app.transcript, startLanguages: ['en'], startTargetLang: 'Chinese',
    bridgeRef: { audioControl() {}, async shutDownPageContainer() { exited = true; return true } },
    addRecord(record) { archived = record; return new Promise(resolve => { finishStorage = resolve }) },
    teardownSession: () => app.session.dispose(),
  })
  vm.runInContext(code, context)
  const ending = vm.runInContext('endSession()', context)
  const stoppedBeforeStorage = app.requests[1].signal.aborted
  assert.equal(exited, false, 'History should still finish before app exit')
  finishStorage()
  await ending
  assert.equal(stoppedBeforeStorage, true, 'Translation must stop as soon as End is pressed')
  assert.equal(archived.translation, '已完成.', 'Only finalized translation belongs in history')
  assert.equal(exited, true)
})
