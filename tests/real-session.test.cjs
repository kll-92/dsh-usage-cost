/* Fold a real recorded session, not a hand-written shape.
 *
 * The synthetic wires in bundle.test.cjs encode what we *think* a Session log
 * looks like. This one is copied from a real `session.v4.jsonl.zstd` (user
 * message text replaced, assistant content dropped, usage and message ids
 * kept), so a change in the recorded event shape shows up as a failing test
 * instead of a silently empty ledger.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const core = require('../src/core.cjs')

const events = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'session-sample.json'), 'utf8'))

test('real session: every completed Turn folds with a message id and a price', () => {
  const rows = core.foldSession(events)
  const turnEnds = events.filter((event) => event.type === 'turn/end').length
  assert.equal(rows.length, turnEnds, 'one row per completed Turn')

  for (const row of rows) {
    assert.equal(typeof row.messageId, 'string', 'Turn ' + row.turn + ' carries a message id')
    assert.notEqual(row.messageId, '')
    assert.ok(row.usage !== undefined, 'Turn ' + row.turn + ' carries usage')
    const cost = core.turnCost(row.usage, row.usage.routes, row.endedAt, core.DEFAULT_PRICES)
    assert.equal(cost.state, 'priced', 'Turn ' + row.turn + ' prices')
    assert.ok(cost.amount > 0)
    assert.match(core.inlineText(cost), /^花费 ≈¥/)
  }
})

test('real session: message ids are unique and match the last assistant message', () => {
  const rows = core.foldSession(events)
  const lastByTurn = new Map()
  for (const event of events) {
    if (event.type === 'assistant/message') lastByTurn.set(event.data.turn, event.data.message.id)
  }
  const ids = rows.map((row) => row.messageId)
  assert.equal(new Set(ids).size, ids.length, 'message ids are unique')
  for (const row of rows) {
    assert.equal(row.messageId, lastByTurn.get(row.turn), 'Turn ' + row.turn + ' uses its final assistant message')
  }
})
