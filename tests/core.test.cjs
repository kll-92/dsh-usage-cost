'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const core = require('../src/core.cjs')

/** Epoch ms for a Beijing wall-clock time. */
function bj(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour - 8, minute || 0)
}

const FLASH = 'deepseek-flash'
const ROUTE = [{ provider: 'deepseek', model: FLASH }]

function usage(overrides) {
  return Object.assign({
    inputTokens: 2000,
    cacheReadTokens: 8000,
    cacheWriteTokens: 0,
    outputTokens: 1000,
    totalTokens: 11000,
  }, overrides)
}

function pricedTurn(overrides) {
  return [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        usage: usage(overrides),
        message: { source: { provider: 'deepseek', model: FLASH } },
      },
    },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1 }, time: bj(2026, 11, 24, 10, 0) },
  ]
}

test('peak window: Tuesday 10:00 is peak, 12:30 and Saturday are not', () => {
  assert.equal(core.isPeak(bj(2026, 11, 24, 10, 0), core.DEFAULT_PRICES), true)
  assert.equal(core.isPeak(bj(2026, 11, 24, 11, 59), core.DEFAULT_PRICES), true)
  assert.equal(core.isPeak(bj(2026, 11, 24, 12, 30), core.DEFAULT_PRICES), false)
  assert.equal(core.isPeak(bj(2026, 11, 24, 15, 0), core.DEFAULT_PRICES), true)
  assert.equal(core.isPeak(bj(2026, 11, 21, 10, 0), core.DEFAULT_PRICES), false)
})

test('peak window: a configured holiday is off-peak even on a weekday', () => {
  const prices = Object.assign({}, core.DEFAULT_PRICES, { holidays: ['2026-11-24'] })
  assert.equal(core.isPeak(bj(2026, 11, 24, 10, 0), prices), false)
})

test('fold: one billed message yields one aggregate usage', () => {
  const events = pricedTurn()
  const result = core.deriveTurnUsage(events)
  assert.equal(result.uncachedInputTokens, 2000)
  assert.equal(result.outputTokens, 1000)
  assert.equal(result.cacheReadTokens, 8000)
  assert.equal(result.totalTokens, 11000)
  assert.deepEqual(result.routes, ROUTE)
})

test('fold: a retried attempt plus the final message are both billed', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    {
      type: 'assistant/attempt',
      data: {
        turn: 1,
        step: 1,
        stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 } } }],
      },
    },
    { type: 'llm/retry', data: { turn: 1, step: 1 } },
    { type: 'llm/retry-started', data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      data: { turn: 1, step: 1, usage: usage({ inputTokens: 20, outputTokens: 7, totalTokens: 27, cacheReadTokens: 0, cacheWriteTokens: 0 }), message: { source: { provider: 'deepseek', model: FLASH } } },
    },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1 }, time: bj(2026, 11, 24, 10, 0) },
  ]
  const result = core.deriveTurnUsage(events)
  assert.equal(result.uncachedInputTokens, 30)
  assert.equal(result.outputTokens, 12)
  assert.equal(result.totalTokens, 42)
})

test('fold: a message outside a step is treated as unavailable, not guessed', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 1, usage: usage(), message: { source: { provider: 'deepseek', model: FLASH } } } },
    { type: 'turn/end', data: { turn: 1 }, time: bj(2026, 11, 24, 10, 0) },
  ]
  assert.equal(core.deriveTurnUsage(events), undefined)
})

test('fold: a turn without turn/end is unavailable', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 1, usage: usage(), message: { source: { provider: 'deepseek', model: FLASH } } } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
  ]
  assert.equal(core.deriveTurnUsage(events), undefined)
})

test('foldSession: keeps the turn prompt and end time, one row per turn', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '## 标题\n看看这个 ```code``` 问题' }] } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 1, usage: usage(), message: { source: { provider: 'deepseek', model: FLASH } } } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'turn/end', data: { turn: 1 }, time: bj(2026, 11, 24, 10, 0) },
  ]
  const rows = core.foldSession(events)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].turn, 1)
  assert.equal(rows[0].endedAt, bj(2026, 11, 24, 10, 0))
  assert.equal(rows[0].prompt, '标题 看看这个 问题')
  assert.equal(rows[0].usage.uncachedInputTokens, 2000)
})

test('foldSession: the row keeps the final assistant message id', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'm-step-1', content: [{ type: 'tool-call', id: 'c1' }] } } },
    { type: 'tool/result', data: {} },
    { type: 'assistant/message', data: { turn: 1, step: 2, usage: usage(), message: { id: 'm-final', source: { provider: 'deepseek', model: FLASH } } } },
    { type: 'turn/end', data: { turn: 1 }, time: bj(2026, 11, 24, 10, 0) },
  ]
  assert.equal(core.finalMessageId(events), 'm-final')
  assert.equal(core.foldSession(events)[0].messageId, 'm-final')
})

test('foldSession: a turn with no assistant message has no message id', () => {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1 }, time: bj(2026, 11, 24, 10, 0) },
  ]
  assert.equal(core.finalMessageId(events), undefined)
  assert.equal(core.foldSession(events)[0].messageId, undefined)
})

test('cost: peak and off-peak use their own prices', () => {
  const peakCost = core.turnCost(core.deriveTurnUsage(pricedTurn()), ROUTE, bj(2026, 11, 24, 10, 0))
  assert.equal(peakCost.state, 'priced')
  assert.equal(peakCost.amount.toFixed(6), ((2000 * 2 + 8000 * 0.04 + 1000 * 8) / 1e6).toFixed(6))

  const offPeakCost = core.turnCost(core.deriveTurnUsage(pricedTurn()), ROUTE, bj(2026, 11, 21, 10, 0))
  assert.equal(offPeakCost.amount.toFixed(6), ((2000 * 1 + 8000 * 0.02 + 1000 * 4) / 1e6).toFixed(6))
  assert.equal(offPeakCost.peak, false)
})

test('cost: cache writes are billed at the cache-miss price', () => {
  const usageWithWrite = core.deriveTurnUsage(pricedTurn({ cacheWriteTokens: 500, totalTokens: 11500 }))
  const cost = core.turnCost(usageWithWrite, ROUTE, bj(2026, 11, 24, 10, 0))
  assert.equal(cost.amount.toFixed(6), ((2500 * 2 + 8000 * 0.04 + 1000 * 8) / 1e6).toFixed(6))
})

test('cost: unknown model or mixed routes are unpriced, never zero', () => {
  const usageValue = core.deriveTurnUsage(pricedTurn())
  const unknown = core.turnCost(usageValue, [{ provider: 'deepseek', model: 'deepseek-v9' }], bj(2026, 11, 24, 10, 0))
  assert.equal(unknown.state, 'unpriced')
  assert.equal(unknown.reason, 'model')
  const mixed = core.turnCost(usageValue, [{ provider: 'a', model: FLASH }, { provider: 'b', model: 'deepseek-v4-pro' }], bj(2026, 11, 24, 10, 0))
  assert.equal(mixed.state, 'unpriced')
  assert.equal(mixed.reason, 'route')
})

test('cost: missing usage is no-data', () => {
  assert.equal(core.turnCost(undefined, ROUTE, bj(2026, 11, 24, 10, 0)).state, 'no-data')
})

test('aggregate: totals money and tokens, excludes unpriced rows from money', () => {
  const priced = { cost: core.turnCost(core.deriveTurnUsage(pricedTurn()), ROUTE, bj(2026, 11, 24, 10, 0)) }
  const unpriced = { cost: { state: 'unpriced', reason: 'model' } }
  const noData = { cost: { state: 'no-data' } }
  const total = core.aggregate([priced, unpriced, noData])
  assert.equal(total.turns, 3)
  assert.equal(total.unpriced, 1)
  assert.equal(total.noData, 1)
  assert.equal(total.tokens, 11000)
  assert.equal(total.amount.toFixed(6), priced.cost.amount.toFixed(6))
})

test('format: money keeps four decimals, totals keep two', () => {
  assert.equal(core.formatMoney(0.0031), '¥0.0031')
  assert.equal(core.formatMoney(0), '¥0.0000')
  assert.equal(core.formatTotalMoney(62), '¥62.00')
})

test('format: compact tokens switch to K and M with one decimal', () => {
  assert.equal(core.formatCompactTokens(999), '999 tokens')
  assert.equal(core.formatCompactTokens(1000), '1K tokens')
  assert.equal(core.formatCompactTokens(12400), '12.4K tokens')
  assert.equal(core.formatCompactTokens(1200000), '1.2M tokens')
})

test('inline: priced text carries the estimate marker, states stay words', () => {
  assert.equal(core.inlineText({ state: 'priced', amount: 0.021, tokens: 12400 }), '≈¥0.0210 · 12.4K tokens')
  assert.equal(core.inlineText({ state: 'unpriced' }), '未定价')
  assert.equal(core.inlineText({ state: 'no-data' }), '无数据')
  assert.equal(core.inlineText({ state: 'pending' }), '¥…')
})

test('budget: threshold, over-budget and unset states', () => {
  assert.deepEqual(core.budgetStatus(62, 100, 80), {
    state: 'set', used: 62, budget: 100, pct: 62, remaining: 38, over: -38, level: 'ok',
  })
  assert.equal(core.budgetStatus(85, 100, 80).level, 'warn')
  assert.equal(core.budgetStatus(120, 100, 80).level, 'over')
  assert.equal(core.budgetStatus(120, 100, 80).over, 20)
  assert.equal(core.budgetStatus(5, 0).state, 'unset')
})

test('csv: quotes and commas survive, total line is last', () => {
  const rows = [{
    timeText: '11-24 10:00',
    prompt: '他说,"你好"',
    usage: { uncachedInputTokens: 2000, cacheReadTokens: 8000, outputTokens: 1000 },
    cost: { state: 'priced', amount: 0.01232, model: FLASH },
  }]
  const csv = core.toCsv(rows)
  const lines = csv.split('\n')
  assert.equal(lines[0], '时间,提问摘要,模型,未命中输入,缓存命中,输出,金额')
  assert.ok(lines[1].includes('"他说,""你好"""'))
  assert.equal(lines[lines.length - 1], '合计,,,,,,0.01')
})

test('excerpt: strips markdown, collapses whitespace, caps length', () => {
  assert.equal(core.excerpt('**粗体** 和 `代码`'), '粗体 和 代码')
  assert.equal(core.excerpt('a'.repeat(100)).length, 81)
})

test('calendar views: today, month, year and all use local calendar boundaries', () => {
  const now = bj(2026, 11, 24, 10, 0)
  assert.equal(core.inView(bj(2026, 11, 24, 9, 0), 'today', now), true)
  assert.equal(core.inView(bj(2026, 11, 23, 23, 50), 'today', now), false)
  assert.equal(core.inView(bj(2026, 11, 23, 23, 50), 'month', now), true)
  assert.equal(core.inView(bj(2026, 10, 31, 23, 0), 'month', now), false)
  assert.equal(core.inView(bj(2026, 1, 1, 0, 30), 'year', now), true)
  assert.equal(core.inView(bj(2025, 12, 31, 23, 0), 'year', now), false)
  assert.equal(core.inView(bj(2025, 1, 1, 0, 0), 'all', now), true)
})

test('prices: validation accepts the defaults and names each bad field', () => {
  assert.deepEqual(core.validatePrices(core.DEFAULT_PRICES), [])
  const broken = JSON.parse(JSON.stringify(core.DEFAULT_PRICES))
  broken.models['deepseek-flash'].peak.output = -1
  const errors = core.validatePrices(broken)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /deepseek-flash/)
  assert.match(errors[0], /output/)
  assert.deepEqual(core.validatePrices({}), ['价格表结构不完整'])
})

test('parseAmount: rejects negatives and junk, keeps zero and decimals', () => {
  assert.equal(core.parseAmount('12.5'), 12.5)
  assert.equal(core.parseAmount('0'), 0)
  assert.equal(core.parseAmount('-3'), undefined)
  assert.equal(core.parseAmount('abc'), undefined)
  assert.equal(core.parseAmount(''), undefined)
})

test('version: a different release is reported, a match is silent', () => {
  assert.equal(core.versionWarning('0.2.2-rc.5', '0.2.2-rc.5'), null)
  assert.match(core.versionWarning('0.3.0', '0.2.2-rc.5'), /0\.3\.0/)
  assert.match(core.versionWarning('0.3.0', '0.2.2-rc.5'), /0\.2\.2-rc\.5/)
  assert.equal(core.versionWarning('', '0.2.2-rc.5'), null, 'unknown release is not a mismatch')
  assert.equal(core.versionWarning(undefined, '0.2.2-rc.5'), null)
})

test('wallet: prefers CNY, folds the bonus wallet, and names the other states', () => {
  const ready = core.walletSummary({
    status: 'ready',
    value: [{ currency: 'USD', balance: '3.00' }, { currency: 'CNY', balance: '12.34' }],
    bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
  })
  assert.equal(ready.state, 'ready')
  assert.equal(ready.text, '¥12.34（赠送 ¥5.00）')
  assert.equal(core.walletSummary({ status: 'ready', value: [{ currency: 'CNY', balance: '15.452700532000000' }], bonusWallets: [] }).text, '¥15.45')

  const noBonus = core.walletSummary({ status: 'ready', value: [{ currency: 'CNY', balance: '7.00' }], bonusWallets: [] })
  assert.equal(noBonus.text, '¥7.00')

  assert.equal(core.walletSummary({ status: 'failed' }).state, 'failed')
  assert.equal(core.walletSummary({ status: 'ready', value: [], bonusWallets: [] }).state, 'empty')
  assert.equal(core.walletSummary(undefined).state, 'unavailable')
})
