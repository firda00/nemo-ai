import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../extension/executor.js', import.meta.url), 'utf8')

class FakeDataTransfer {
  files = []
  items = { add: (file) => this.files.push(file) }
}

class FakeEvent {
  constructor(type, init = {}) { this.type = type; this.bubbles = Boolean(init.bubbles) }
}

const fetchData = async (url) => {
  const [, encoded = ''] = String(url).split(',', 2)
  const bytes = Buffer.from(encoded, 'base64')
  return { blob: async () => new Blob([bytes]) }
}

const { runPlan } = new Function(
  'fetch', 'File', 'DataTransfer', 'Event',
  `${source}\nreturn { runPlan };`,
)(fetchData, File, FakeDataTransfer, FakeEvent)

const events = []
const fileInput = {
  tagName: 'INPUT', type: 'file', multiple: true, disabled: false, files: [],
  getAttribute: () => null,
  dispatchEvent: (event) => events.push(event.type),
}

const png = Buffer.from('real-image-bytes')
const success = await runPlan([{
  type: 'upload', id: 1, files: [{
    name: 'cover.png', type: 'image/png', size: png.length,
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
  }],
}], { elementById: () => fileInput })

assert.equal(success.done, 1)
assert.equal(success.failed, 0)
assert.equal(success.results[0].uploaded, 1)
assert.deepEqual(events, ['input', 'change'])
assert.equal(fileInput.files[0].name, 'cover.png')

const rejected = await runPlan([{
  type: 'upload', id: 1, files: [{
    name: 'payload.svg', type: 'image/svg+xml', size: 4,
    dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=',
  }],
}], { elementById: () => fileInput })
assert.equal(rejected.done, 0)
assert.equal(rejected.results[0].error, 'unsupported_file')

const riskyButton = {
  disabled: false,
  clicked: false,
  innerText: 'Отправить на модерацию',
  getAttribute: (name) => name === 'data-nemo-risky' ? 'true' : null,
  click() { this.clicked = true },
}
const blocked = await runPlan([{ type: 'click', id: 2 }], { elementById: () => riskyButton })
assert.equal(blocked.results[0].error, 'needs_confirmation')
assert.equal(riskyButton.clicked, false)

const confirmed = await runPlan([{ type: 'click', id: 2 }], {
  elementById: () => riskyButton,
  confirmRisky: true,
})
assert.equal(confirmed.results[0].risky, true)
assert.equal(confirmed.results[0].effect, 'submit')
assert.equal(riskyButton.clicked, true)

console.log('[OK] Extension executor behaviour: 14 assertions')
