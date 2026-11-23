'use strict'

/* Smoke test for the built bundle: execute client.js the way the module loader
 * does, materialize the factory once, and run `apply` against a fake context.
 * It proves the bundle parses, publishes what it promises, and registers the
 * three seats without touching a browser. Visual rendering is not covered. */

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

function loadBundle() {
  const code = readFileSync(join(__dirname, '..', 'client.js'), 'utf8')
  let registration
  const window = { __ModuleLoader__: { load(value) { registration = value } } }
  // eslint-disable-next-line no-new-func
  new Function('window', 'globalThis', code)(window, window)
  assert.ok(registration, 'bundle registered a factory')
  return { registration, window }
}

function fakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useSyncExternalStore: () => ({}),
  }
}

test('bundle registers its id and exposes apply/inject', () => {
  const bundle = loadBundle().registration
  assert.equal(bundle.id, '@local/usage-cost')
  const exports = bundle.factory((name) => {
    assert.equal(name, 'react')
    return fakeReact()
  })
  assert.ok(exports && typeof exports.apply === 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale', 'remote', 'remote.session', 'layout'])
})

test('apply registers the sidebar entry, the panel and the inline pill', () => {
  const bundle = loadBundle().registration
  const exports = bundle.factory(() => fakeReact())
  const registered = []
  const disposers = []
  const ctx = {
    get: () => undefined,
    // Optional dependencies: pretend the account service never arrives, so the
    // plugin must stay usable without it.
    inject: () => {},
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    slots: {
      inject: (key, callback) => {
        callback()
        return () => {}
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  const names = registered.map((entry) => entry.options.name).sort()
  assert.deepEqual(names, ['conversation.chat.assistant-actions', 'main', 'sidebar.panellist'])
  assert.equal(registered.find((entry) => entry.options.name === 'sidebar.panellist').options.id, 'usage-cost')
  assert.equal(registered.find((entry) => entry.options.name === 'main').options.key, 'usage-cost')
  assert.equal(typeof disposers.length, 'number')
  assert.ok(disposers.length >= 4, 'every effect returned a disposer')
})

test('ledger backfill publishes a new snapshot and one priced row', async () => {
  const loaded = loadBundle()
  loaded.registration.factory(() => fakeReact())
  const UI = loaded.window.__USAGE_COST_UI__
  assert.ok(UI && typeof UI.createLedger === 'function', 'ui half published its factory')

  const wire = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500, totalTokens: 1500 },
        message: { id: 'm1', source: { provider: 'deepseek', model: 'deepseek-flash' } },
      },
    },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1 }, time: Date.UTC(2026, 10, 24, 2, 0) },
  ].map((event, index) => Object.assign({ seq: index + 1, time: event.time || Date.UTC(2026, 10, 24, 2, 0) }, event))

  // Every Remote method answers with `{ ok, value }`; a fake that returns the
  // bare payload would pass while the real host stays unread.
  const remote = {
    session: {
      list: async () => ({ ok: true, value: { items: [{ sessionId: 's1', cwd: '/w' }] } }),
      events: async () => ({ ok: true, value: { records: wire.map((event) => ({ type: 'event', event })), hasMore: false } }),
    },
  }

  const ledger = UI.createLedger({}, () => remote)
  const before = ledger.snapshot()
  let notified = 0
  ledger.subscribe(() => { notified += 1 })
  await ledger.backfill()

  assert.notEqual(ledger.snapshot(), before, 'snapshot reference must change for React to re-render')
  assert.ok(notified > 0, 'subscribers were notified')
  assert.equal(ledger.snapshot().status, 'ready')
  const rows = ledger.decoratedRows('all')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].prompt, '你好')
  assert.equal(rows[0].cost.state, 'priced')
  assert.equal(rows[0].cost.amount.toFixed(6), ((1000 * 2 + 500 * 8) / 1e6).toFixed(6))
  assert.equal(ledger.rowForMessage('s1', 'm1').turn, 1, 'the Turn row is reachable by message id')
  assert.equal(ledger.rowForMessage(undefined, 'm1').turn, 1, 'and without the Session id as well')
  assert.equal(ledger.rowForMessage('s2', 'm1'), undefined, 'another Session does not match')
  ledger.dispose()
})

test('inline shows the same amount the panel derives for that row', async () => {
  const loaded = loadBundle()
  const react = fakeReact()
  loaded.registration.factory(() => react)
  const UI = loaded.window.__USAGE_COST_UI__
  const CORE = loaded.window.__USAGE_COST_CORE__
  const wire = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '多少钱' }] } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500, totalTokens: 1500 },
        message: { id: 'm1', source: { provider: 'deepseek', model: 'deepseek-flash' } },
      },
    },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1 }, time: Date.UTC(2026, 10, 24, 2, 0) },
  ].map((event, index) => Object.assign({ seq: index + 1, time: event.time || Date.UTC(2026, 10, 24, 2, 0) }, event))

  const remote = {
    session: {
      list: async () => ({ ok: true, value: { items: [{ sessionId: 's1' }] } }),
      events: async () => ({ ok: true, value: { records: wire.map((event) => ({ type: 'event', event })), hasMore: false } }),
    },
  }
  const ledger = UI.createLedger({}, () => remote)
  await ledger.backfill()
  const ui = UI.createUi(react, {}, ledger, undefined)

  const row = ledger.rowForMessage('s1', 'm1')
  const panelCost = CORE.turnCost(row.usage, row.usage && row.usage.routes, row.endedAt, ledger.snapshot().prices)
  assert.equal(panelCost.state, 'priced')
  const inline = ui.Inline({ sessionId: 's1', messageId: 'm1' })
  assert.deepEqual(inline.children, [CORE.inlineText(panelCost)], 'same row, same price table, same string')
  assert.match(inline.props.title, /≈/)
  ledger.dispose()
})

test('focusTurn names the Turn an inline amount points at', async () => {
  const loaded = loadBundle()
  const react = fakeReact()
  loaded.registration.factory(() => react)
  const UI = loaded.window.__USAGE_COST_UI__
  const wire = [
    { type: 'turn/start', data: { turn: 3 } },
    { type: 'step/start', data: { turn: 3, step: 1 } },
    { type: 'assistant/message', data: { turn: 3, step: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 }, message: { id: 'm3', source: { provider: 'deepseek', model: 'deepseek-flash' } } } },
    { type: 'step/end', data: { turn: 3, step: 1 } },
    { type: 'turn/end', data: { turn: 3 }, time: Date.UTC(2026, 10, 24, 2, 0) },
  ].map((event, index) => Object.assign({ seq: index + 1, time: Date.UTC(2026, 10, 24, 2, 0) }, event))
  const remote = {
    session: {
      list: async () => ({ ok: true, value: { items: [{ sessionId: 's1' }] } }),
      events: async () => ({ ok: true, value: { records: wire.map((event) => ({ type: 'event', event })), hasMore: false } }),
    },
  }
  const ledger = UI.createLedger({}, () => remote)
  await ledger.backfill()

  assert.equal(ledger.focusTurn('s1', 'unknown'), false, 'unknown message does not focus')
  assert.equal(ledger.focusTurn('s1', 'm3'), true)
  assert.deepEqual(ledger.snapshot().focus, { sessionId: 's1', turn: 3 })
  ledger.clearFocus()
  assert.equal(ledger.snapshot().focus, null)

  const ui = UI.createUi(react, {}, ledger, undefined)
  ledger.focusTurn('s1', 'm3')
  assert.equal(ui.Panel().type, 'section', 'panel still renders with a locate request')
  ledger.dispose()
})

test('panel and inline build a tree without throwing', () => {
  const loaded = loadBundle()
  const react = fakeReact()
  loaded.registration.factory(() => react)
  const UI = loaded.window.__USAGE_COST_UI__
  const ledger = UI.createLedger({}, () => undefined)
  const ui = UI.createUi(react, {}, ledger, undefined)

  const panel = ui.Panel()
  assert.equal(panel.type, 'section')
  const inline = ui.Inline({ sessionId: 's1', messageId: 'm1' })
  assert.equal(inline.type, 'button')
  assert.deepEqual(inline.children, ['¥…'])
  ledger.dispose()
})

test('a refused backfill says why instead of reporting no data', async () => {
  const loaded = loadBundle()
  loaded.registration.factory(() => fakeReact())
  const UI = loaded.window.__USAGE_COST_UI__
  const remote = {
    session: {
      list: async () => ({ ok: false, error: { code: 'remote-access/denied', message: 'not allowed' } }),
    },
  }
  const ledger = UI.createLedger({}, () => remote)
  await ledger.backfill()
  assert.equal(ledger.snapshot().status, 'error')
  assert.match(ledger.snapshot().error, /remote-access\/denied/)
  ledger.dispose()
})

test('the unavailability message carries the recorded reason', async () => {
  const loaded = loadBundle()
  loaded.registration.factory(() => fakeReact())
  const UI = loaded.window.__USAGE_COST_UI__
  const ledger = UI.createLedger({}, () => undefined, () => 'cannot get property "remote" without inject')
  await ledger.backfill()
  assert.equal(ledger.snapshot().status, 'error')
  assert.match(ledger.snapshot().error, /cannot get property "remote"/)
  ledger.dispose()
})

test('an un-injected service proxy is reported, not thrown', async () => {
  const loaded = loadBundle()
  loaded.registration.factory(() => fakeReact())
  const UI = loaded.window.__USAGE_COST_UI__
  // Cordis hands out a strict proxy before the service is declared in inject;
  // touching a member of it throws. The ledger must survive that shape.
  const trapped = { get session() { throw new Error('cannot get property "remote.session" without inject') } }
  const ledger = UI.createLedger({}, () => trapped)
  assert.equal(ledger.hasRemote(), false)
  await ledger.backfill()
  assert.equal(ledger.snapshot().status, 'error')
  assert.match(ledger.snapshot().error, /会话读取接口/)
  ledger.dispose()
})

test('panel renders with real ledger rows without falling into the error page', async () => {
  const loaded = loadBundle()
  const react = fakeReact()
  loaded.registration.factory(() => react)
  const UI = loaded.window.__USAGE_COST_UI__
  const wire = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '查一下这个' }] } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        usage: { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500, totalTokens: 1500 },
        message: { id: 'm1', source: { provider: 'deepseek', model: 'deepseek-flash' } },
      },
    },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    // Fixed peak-time epoch (Tuesday 10:00 Beijing): the price must not depend
    // on when the test suite happens to run.
    { type: 'turn/end', data: { turn: 1 }, time: Date.UTC(2026, 10, 24, 2, 0) },
  ].map((event, index) => Object.assign({ seq: index + 1, time: event.time || Date.UTC(2026, 10, 24, 2, 0) }, event))
  const remote = {
    session: {
      list: async () => ({ ok: true, value: { items: [{ sessionId: 's1', cwd: '/w' }] } }),
      events: async () => ({ ok: true, value: { records: wire.map((event) => ({ type: 'event', event })), hasMore: false } }),
    },
  }
  const ledger = UI.createLedger({}, () => remote)
  await ledger.backfill()
  const ui = UI.createUi(react, {}, ledger, undefined)
  const panel = ui.Panel()
  assert.equal(panel.type, 'section')
  const inline = ui.Inline({ sessionId: 's1', messageId: 'm1' })
  assert.deepEqual(inline.children, ['≈¥' + (0.006).toFixed(4) + ' · 1.5K tokens'])
  ledger.dispose()
})

test('host half asks the module registry to re-read the client bundle', async () => {
  const { apply } = await import('../index.js')
  const ids = []
  let effects = 0
  const ctx = {
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['clientModules'])
      callback({ clientModules: { rebuilt: (id) => { ids.push(id) } } })
    },
    effect: (callback) => { effects += 1; callback(); return () => {} },
  }
  apply(ctx)
  assert.deepEqual(ids, ['@local/usage-cost'])
  assert.equal(effects, 1)
})
