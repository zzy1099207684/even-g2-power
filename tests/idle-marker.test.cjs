const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')

async function marker() {
  const { getTextWidth } = await import('@evenrealities/pretext')
  const source = fs.readFileSync(require('node:path').join(__dirname, '../src/main.ts'), 'utf8')
  const block = source.slice(source.indexOf('const MARKER_BLINK_MS'), source.indexOf('// Committing:'))
  let now = 100_000, interval, stepMs
  let frameWrite = Promise.resolve()
  const contents = ['']
  const c = vm.createContext({
    DEFAULT_SCREEN_CLEAR_SECONDS: 15, Date: { now: () => now },
    paused: false, startLanguages: ['en'], startTargetCode: 'zh', displayMode: 'both',
    markerRenderer: { schedule: text => { contents[0] = text }, flush: () => frameWrite },
    originalRenderer: { schedule() {} }, translationRenderer: { schedule() {} },
    transcript: { isAtLive: () => true, getGlassesOriginal: () => '', getGlassesTranslation: () => '' },
    setInterval: (fn, ms) => { interval = fn; stepMs = ms; return 1 },
  })
  vm.runInContext(ts.transpile(block, { target: ts.ScriptTarget.ES2022 }), c)
  vm.runInContext('startIdleBlink()', c)
  return {
    c, contents,
    async tick(ms = stepMs) { now += ms; interval(); await Promise.resolve() },
    get elapsed() { return now - 100_000 },
    holdWrite() { let release; frameWrite = new Promise(resolve => { release = resolve }); return release },
    positions() {
      const result = []
      for (let container = 0; container < contents.length; container++) {
        const text = contents[container]
        for (let i = 0; i < text.length; i++) {
          if (text[i] === '·') result.push(getTextWidth(text.slice(0, i)))
        }
      }
      return result.sort((a, b) => a - b)
    },
  }
}

test('silent dots spread in three 450ms steps and return to the center', async () => {
  const app = await marker()
  await app.tick(15_000)
  const first = app.positions()
  assert.equal(first.length, 1)
  let previous = [first[0], first[0]]
  const startedAt = app.elapsed
  for (let i = 0; i < 3; i++) {
    await app.tick()
    const positions = app.positions()
    assert.equal(positions.length, 2)
    assert.equal(previous[0] - positions[0], 5, 'left dot moves one full step')
    assert.equal(positions[1] - previous[1], 5, 'right dot moves one full step')
    assert.equal((positions[0] + positions[1]) / 2, first[0], 'center must stay fixed')
    previous = positions
  }
  assert.deepEqual(previous, [first[0] - 15, first[0] + 15])
  assert.equal(app.elapsed - startedAt, 1350, 'three steps at 450ms each')
  await app.tick()
  assert.deepEqual(app.positions(), first)
})

test('large dot retains 900ms blink timing', async () => {
  const app = await marker()
  for (let tick = 0; tick < 8; tick++) {
    if (tick) await app.tick()
    assert.equal(app.contents[0].endsWith('●'), Math.floor(app.elapsed / 900) % 2 === 1)
  }
})

test('pause stays static and history hides the dots', async () => {
  const app = await marker()
  await app.tick(15_000); await app.tick()
  assert.ok(app.positions().length > 0)
  app.c.paused = true; await app.tick()
  assert.ok(app.contents[0].startsWith('pause'))
  const paused = [...app.contents]
  await app.tick()
  assert.deepEqual(app.contents, paused)
  app.c.paused = false
  app.c.transcript.isAtLive = () => false; await app.tick()
  assert.ok(app.contents.every(text => text === ''))
  app.c.transcript.isAtLive = () => true; await app.tick()
  assert.equal(app.positions().length, 1)
})

test('a slow frame write neither accumulates frames nor slows the animation clock', async () => {
  const app = await marker()
  await app.tick(15_000)
  const release = app.holdWrite()
  await app.tick()
  const pending = [...app.contents]
  for (let i = 0; i < 10; i++) await app.tick()
  assert.deepEqual(app.contents, pending, 'do not enqueue more animation while a frame is pending')
  release(); await Promise.resolve()
  await app.tick()
  assert.notDeepEqual(app.contents, pending, 'animation resumes when the bridge catches up')
  assert.deepEqual(app.positions(), [94], 'after 5.4s, return to the current center frame instead of replaying stale steps')
})
