const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')

test('diagnostics distinguish a device-rejected write from success without logging displayed text', async () => {
  const pretext = await import('@evenrealities/pretext')
  const modules = new Map()
  const context = vm.createContext({ setTimeout, clearTimeout })
  function load(name) {
    if (modules.has(name)) return modules.get(name)
    const module = { exports: {} }
    const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, `../src/${name}.ts`), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    vm.runInContext(`(function(require,module,exports){${code}\n})`, context)(dependency => {
      if (dependency === '@evenrealities/pretext') return pretext
      if (dependency === '@evenrealities/even_hub_sdk') return { TextContainerUpgrade: class { constructor(value) { Object.assign(this, value) } } }
      return load(dependency.replace('./', ''))
    }, module, module.exports)
    modules.set(name, module.exports)
    return module.exports
  }
  const render = load('render')
  const diagnostics = load('diagnostics').diagnostics
  let result = false
  const renderer = render.createContainerRenderer({ textContainerUpgrade: async () => result },
    render.createWriteQueue(), 1, 'original', { innerWidth: 568, maxLines: 4 })
  renderer.schedule('PRIVATE DISPLAY')
  await renderer.flush()
  let logs = diagnostics.exportText()
  assert.match(logs, /glasses.write_rejected/)
  assert.doesNotMatch(logs, /"glasses.writesOk":1/)
  assert.doesNotMatch(logs, /PRIVATE DISPLAY/)
  result = true
  renderer.schedule('SECOND PRIVATE DISPLAY')
  await renderer.flush()
  logs = diagnostics.exportText()
  assert.match(logs, /"glasses.writesOk":1/)
})
