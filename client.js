window.__ModuleLoader__.load({
  id: '@local/usage-cost',
  factory(require) {
;
/* Usage-cost core: pure functions shared by the panel, the inline pill and the tests.
 *
 * Loaded two ways:
 *   - browser: as a classic script, it publishes `window.__USAGE_COST_CORE__`
 *   - tests:   through CommonJS `require`, it exports the same object
 * It has no imports and touches no DOM, so the money math is testable on its own.
 */
(function (root) {
  'use strict'

  /** Beijing is UTC+8 all year: no daylight saving to consider. */
  var SHANGHAI_OFFSET_MS = 8 * 3600 * 1000
  var CURRENCY = 'CNY'
  /** Only this DSH release has been verified against these interfaces. */
  var VERIFIED_DSH_VERSION = '0.2.2-rc.5'
  var UNIT = 1000000

  /**
   * DeepSeek official prices, CNY per million tokens, 2026-11-23.
   * Peak: Beijing Monday-Friday 9:00-12:00 and 14:00-18:00, excluding CN statutory holidays.
   * `holidays` is an editable list of 'YYYY-MM-DD' local dates.
   */
  var DEFAULT_PRICES = {
    version: '2026-11-23',
    currency: CURRENCY,
    unit: UNIT,
    models: {
      'deepseek-flash': {
        peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
        offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
      },
      'deepseek-v4-pro': {
        peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
        offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
      },
    },
    holidays: [],
  }

  function isCount(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  }

  function safeSum(values) {
    var total = 0
    for (var i = 0; i < values.length; i += 1) {
      total += values[i]
      if (!Number.isSafeInteger(total)) return undefined
    }
    return total
  }

  /** Last provider `usage` chunk of one durable assistant stream. */
  function lastUsageChunk(stream) {
    if (!Array.isArray(stream)) return undefined
    for (var i = stream.length - 1; i >= 0; i -= 1) {
      var record = stream[i]
      if (record && record.type === 'chunk' && record.chunk && record.chunk.type === 'usage') {
        return record.chunk.usage
      }
    }
    return undefined
  }

  function messageRoute(message) {
    var source = message && message.source
    if (!source || typeof source.provider !== 'string' || typeof source.model !== 'string') return undefined
    return source.provider.length > 0 && source.model.length > 0
      ? { provider: source.provider, model: source.model }
      : undefined
  }

  function normalizeUsage(usage, route) {
    if (!usage) return undefined
    var inputTokens = usage.inputTokens
    var outputTokens = usage.outputTokens
    var cacheReadTokens = usage.cacheReadTokens
    var cacheWriteTokens = usage.cacheWriteTokens
    var reasoningTokens = usage.reasoningTokens
    var totalTokens = usage.totalTokens
    if (!isCount(inputTokens) || !isCount(outputTokens)) return undefined
    if (cacheReadTokens !== undefined && !isCount(cacheReadTokens)) return undefined
    if (cacheWriteTokens !== undefined && !isCount(cacheWriteTokens)) return undefined
    if (reasoningTokens !== undefined && (!isCount(reasoningTokens) || reasoningTokens > outputTokens)) return undefined

    var knownPrompt = safeSum([inputTokens]
      .concat(cacheReadTokens === undefined ? [] : [cacheReadTokens])
      .concat(cacheWriteTokens === undefined ? [] : [cacheWriteTokens]))
    if (knownPrompt === undefined) return undefined

    var exactTotal
    if (totalTokens !== undefined) {
      if (!isCount(totalTokens)) return undefined
      var exactPrompt = totalTokens - outputTokens
      if (!isCount(exactPrompt) || exactPrompt < knownPrompt) return undefined
      if (cacheReadTokens !== undefined && cacheWriteTokens !== undefined && exactPrompt !== knownPrompt) return undefined
      exactTotal = totalTokens
    } else {
      if (cacheReadTokens === undefined || cacheWriteTokens === undefined) return undefined
      var derivedTotal = safeSum([knownPrompt, outputTokens])
      if (derivedTotal === undefined) return undefined
      exactTotal = derivedTotal
    }

    var attempt = { inputTokens: inputTokens, outputTokens: outputTokens, totalTokens: exactTotal }
    if (cacheReadTokens !== undefined) attempt.cacheReadTokens = cacheReadTokens
    if (cacheWriteTokens !== undefined) attempt.cacheWriteTokens = cacheWriteTokens
    if (reasoningTokens !== undefined) attempt.reasoningTokens = reasoningTokens
    if (route !== undefined) attempt.route = route
    return attempt
  }

  function aggregateAttempts(attempts) {
    if (attempts.length === 0) return undefined
    var inputTokens = safeSum(attempts.map(function (a) { return a.inputTokens }))
    var outputTokens = safeSum(attempts.map(function (a) { return a.outputTokens }))
    var totalTokens = safeSum(attempts.map(function (a) { return a.totalTokens }))
    if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) return undefined

    var cacheRead = attempts.map(function (a) { return a.cacheReadTokens })
    var cacheWrite = attempts.map(function (a) { return a.cacheWriteTokens })
    var reasoning = attempts.map(function (a) { return a.reasoningTokens })
    var cacheReadTokens = cacheRead.every(isCount) ? safeSum(cacheRead) : undefined
    var cacheWriteTokens = cacheWrite.every(isCount) ? safeSum(cacheWrite) : undefined
    var reasoningTokens = reasoning.every(isCount) ? safeSum(reasoning) : undefined

    var routes
    var attributed = attempts.map(function (a) { return a.route })
    if (attributed.every(function (route) { return route !== undefined })) {
      var unique = {}
      attributed.forEach(function (route) { unique[route.provider + '\u0000' + route.model] = route })
      routes = Object.keys(unique).map(function (key) { return unique[key] })
    }

    var usage = { uncachedInputTokens: inputTokens, outputTokens: outputTokens, totalTokens: totalTokens }
    if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens
    if (cacheWriteTokens !== undefined) usage.cacheWriteTokens = cacheWriteTokens
    if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens
    if (routes !== undefined) usage.routes = routes
    return usage
  }

  /**
   * Fold one complete Turn's durable attempt lifecycle into aggregate usage.
   * A missing boundary, incomplete usage, unsafe count or contradictory total
   * makes the whole Turn unavailable — the same rule the chat panel applies.
   */
  function deriveTurnUsage(events) {
    var state = { kind: 'idle' }
    var attempts = []
    var turn
    var sawEnd = false
    var invalid = false

    function sameAttempt(step) {
      return state.turn === turn && state.step === step
    }

    function closeOpen(route) {
      if (state.kind !== 'open' || state.sample === undefined) return false
      var normalized = normalizeUsage(state.sample, route)
      if (normalized === undefined) return false
      attempts.push(normalized)
      return true
    }

    for (var i = 0; i < events.length; i += 1) {
      var event = events[i]
      if (!event || invalid) break
      if (event.type === 'turn/start') {
        if (turn !== undefined || state.kind !== 'idle') invalid = true
        else turn = event.data.turn
        continue
      }
      if (turn === undefined) { invalid = true; break }
      if (event.type === 'turn/end') {
        if (event.data.turn !== turn || state.kind !== 'idle' || sawEnd) invalid = true
        else sawEnd = true
        continue
      }
      if (sawEnd) { invalid = true; break }
      if (event.type === 'step/start') {
        if (event.data.turn !== turn || state.kind !== 'idle') invalid = true
        else state = { kind: 'open', turn: turn, step: event.data.step }
        continue
      }
      if (event.type === 'llm/retry-started') {
        if (event.data.turn !== turn || state.kind !== 'settled' || state.by !== 'retry'
          || !sameAttempt(event.data.step)) invalid = true
        else state = { kind: 'open', turn: turn, step: event.data.step }
        continue
      }
      if (event.type === 'assistant/attempt') {
        if (event.data.turn !== turn || state.kind !== 'open' || !sameAttempt(event.data.step)) {
          invalid = true
          continue
        }
        var attemptSample = lastUsageChunk(event.data.stream)
        var next = { kind: 'open', turn: turn, step: event.data.step }
        if (attemptSample !== undefined) next.sample = attemptSample
        else if (state.sample !== undefined) next.sample = state.sample
        state = next
        if (!closeOpen()) invalid = true
        else state = { kind: 'finishClosed', turn: turn, step: event.data.step }
        continue
      }
      if (event.type === 'assistant/message') {
        if (event.data.turn !== turn || state.kind !== 'open' || !sameAttempt(event.data.step)) {
          invalid = true
          continue
        }
        var sample = event.data.usage !== undefined ? event.data.usage : lastUsageChunk(event.data.stream)
        if (sample !== undefined) state = { kind: 'open', turn: turn, step: state.step, sample: sample }
        if (!closeOpen(messageRoute(event.data.message))) invalid = true
        else state = { kind: 'settled', turn: turn, step: event.data.step, by: 'message' }
        continue
      }
      if (event.type === 'llm/retry') {
        if (event.data.turn !== turn || state.kind === 'idle' || !sameAttempt(event.data.step)) {
          invalid = true
          continue
        }
        if (state.kind === 'settled' || (state.kind === 'open' && !closeOpen())) invalid = true
        if (!invalid) state = { kind: 'settled', turn: turn, step: event.data.step, by: 'retry' }
        continue
      }
      if (event.type === 'step/end') {
        if (event.data.turn !== turn || state.kind === 'idle' || !sameAttempt(event.data.step)) {
          invalid = true
          continue
        }
        if (state.kind === 'open' && !closeOpen()) invalid = true
        if (!invalid) state = { kind: 'idle' }
      }
    }

    return invalid || !sawEnd || state.kind !== 'idle' ? undefined : aggregateAttempts(attempts)
  }

  /** Plain text of one user message, flattened from its content blocks. */
  function messageText(message) {
    if (!message) return ''
    if (typeof message.text === 'string') return message.text
    var blocks = Array.isArray(message.content) ? message.content : []
    var parts = []
    for (var i = 0; i < blocks.length; i += 1) {
      var block = blocks[i]
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join(' ')
  }

  /** One-line excerpt: markdown markers removed, whitespace collapsed, capped. */
  function excerpt(text, limit) {
    var max = typeof limit === 'number' ? limit : 80
    if (typeof text !== 'string') return ''
    var plain = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`/g, '')
      .replace(/^[>\s]*#+\s*/gm, ' ')
      .replace(/[*_~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    return plain.length > max ? plain.slice(0, max) + '…' : plain
  }

  /**
   * Compare the running Harness release with the one this plugin was verified
   * against.
   *
   * A silent mismatch is worse than a visible one: interface names and slot
   * contracts move between releases, and the panel would then look broken
   * rather than outdated.
   * @returns null when there is nothing to say, otherwise a readable warning.
   */
  function versionWarning(running, verified) {
    if (typeof running !== 'string' || running === '') return null
    if (typeof verified !== 'string' || verified === '') return null
    if (running === verified) return null
    return '运行在 DSH ' + running + '，本插件验证于 ' + verified
  }

  /**
   * Durable id of one Turn's final assistant message.
   *
   * The chat UI identifies a Turn's action row by this id, not by the Turn
   * number, so the ledger keeps it: it is the only key that lets an inline
   * amount find its own Turn.
   * @returns the message id, or undefined when the Turn has no assistant message.
   */
  function finalMessageId(events) {
    for (var i = events.length - 1; i >= 0; i -= 1) {
      var event = events[i]
      if (!event || event.type !== 'assistant/message') continue
      var message = event.data && event.data.message
      if (message && typeof message.id === 'string' && message.id !== '') return message.id
    }
    return undefined
  }

  /**
   * Fold a session's event list into completed Turn rows.
   * @returns rows `{ turn, endedAt, prompt, usage, messageId }`; `usage` is undefined when unavailable.
   */
  function foldSession(events) {
    var rows = []
    var current = null
    for (var i = 0; i < events.length; i += 1) {
      var event = events[i]
      if (!event || typeof event.type !== 'string') continue
      if (event.type === 'turn/start') {
        if (current !== null) rows.push(current)
        current = { turn: event.data.turn, events: [event], prompt: '', endedAt: undefined }
        continue
      }
      if (current === null) continue
      current.events.push(event)
      if (event.type === 'user/message' && current.prompt === '') {
        current.prompt = messageText(event.data)
      }
      if (event.type === 'turn/end') {
        current.endedAt = typeof event.time === 'number' ? event.time : undefined
        rows.push(current)
        current = null
      }
    }
    if (current !== null) rows.push(current)

    return rows.map(function (row) {
      return {
        turn: row.turn,
        endedAt: row.endedAt,
        prompt: excerpt(row.prompt),
        usage: deriveTurnUsage(row.events),
        messageId: finalMessageId(row.events),
      }
    })
  }

  function shanghaiParts(atMs) {
    var date = new Date(atMs + SHANGHAI_OFFSET_MS)
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      weekday: date.getUTCDay(),
    }
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value)
  }

  /** Local calendar key, e.g. `2026-11-23`. */
  function dateKey(atMs) {
    var parts = shanghaiParts(atMs)
    return parts.year + '-' + pad2(parts.month) + '-' + pad2(parts.day)
  }

  function monthKey(atMs) {
    var parts = shanghaiParts(atMs)
    return parts.year + '-' + pad2(parts.month)
  }

  function isHoliday(atMs, prices) {
    var list = (prices && prices.holidays) || []
    return list.indexOf(dateKey(atMs)) !== -1
  }

  /** Peak pricing window: Mon-Fri 09:00-12:00 and 14:00-18:00, not a holiday. */
  function isPeak(atMs, prices) {
    var parts = shanghaiParts(atMs)
    if (parts.weekday === 0 || parts.weekday === 6) return false
    if (isHoliday(atMs, prices)) return false
    return (parts.hour >= 9 && parts.hour < 12) || (parts.hour >= 14 && parts.hour < 18)
  }

  /** Whether one turn belongs to the given calendar view, relative to `now`. */
  function inView(endedAt, view, now) {
    if (typeof endedAt !== 'number') return false
    if (view === 'all') return true
    if (view === 'today') return dateKey(endedAt) === dateKey(now)
    if (view === 'month') return monthKey(endedAt) === monthKey(now)
    if (view === 'year') return shanghaiParts(endedAt).year === shanghaiParts(now).year
    return false
  }

  /** Model id of one route set, or undefined when the set is missing or mixed. */
  function singleModel(routes) {
    if (!Array.isArray(routes) || routes.length === 0) return undefined
    var models = routes.map(function (route) { return route && route.model })
    var first = models[0]
    if (typeof first !== 'string' || first === '') return undefined
    for (var i = 1; i < models.length; i += 1) if (models[i] !== first) return undefined
    return first
  }

  function modelPrice(model, peak, prices) {
    var table = (prices || DEFAULT_PRICES).models || {}
    var entry = table[model]
    if (!entry) return undefined
    return peak ? entry.peak : entry.offPeak
  }

  /**
   * Cost of one Turn.
   * @returns `{ state:'priced', amount, tokens, model, peak }`,
   *          `{ state:'unpriced', reason }`, or `{ state:'no-data' }`.
   */
  function turnCost(usage, routes, atMs, prices) {
    if (!usage || !isCount(usage.uncachedInputTokens) || !isCount(usage.outputTokens)) {
      return { state: 'no-data' }
    }
    var model = singleModel(routes)
    if (model === undefined) return { state: 'unpriced', reason: 'route' }
    var peak = isPeak(atMs, prices)
    var price = modelPrice(model, peak, prices)
    if (!price) return { state: 'unpriced', reason: 'model', model: model }

    var miss = usage.uncachedInputTokens + (usage.cacheWriteTokens || 0)
    var hit = usage.cacheReadTokens || 0
    var output = usage.outputTokens || 0
    var amount = (miss * price.cacheMiss + hit * price.cacheHit + output * price.output) / ((prices || DEFAULT_PRICES).unit || UNIT)
    return { state: 'priced', amount: amount, tokens: miss + hit + output, model: model, peak: peak }
  }

  /** Totals over a row set; unpriced rows are counted but never add money. */
  function aggregate(rows) {
    var total = { amount: 0, tokens: 0, turns: 0, unpriced: 0, noData: 0 }
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i]
      total.turns += 1
      if (!row.cost || row.cost.state === 'no-data') { total.noData += 1; continue }
      if (row.cost.state === 'unpriced') { total.unpriced += 1; continue }
      total.amount += row.cost.amount
      total.tokens += row.cost.tokens
    }
    return total
  }

  function formatMoney(amount) {
    var value = typeof amount === 'number' && isFinite(amount) ? amount : 0
    return '¥' + value.toFixed(4)
  }

  function formatTotalMoney(amount) {
    var value = typeof amount === 'number' && isFinite(amount) ? amount : 0
    return '¥' + value.toFixed(2)
  }

  function compactNumber(value) {
    if (value < 1000) return String(value)
    if (value < UNIT) return trimOneDecimal(value / 1000) + 'K'
    return trimOneDecimal(value / UNIT) + 'M'
  }

  function trimOneDecimal(value) {
    var text = (Math.round(value * 10) / 10).toFixed(1)
    return text.slice(-2) === '.0' ? text.slice(0, -2) : text
  }

  function formatCompactTokens(tokens) {
    var value = typeof tokens === 'number' && isFinite(tokens) ? Math.max(0, Math.round(tokens)) : 0
    return compactNumber(value) + ' tokens'
  }

  /** Inline pill text: `≈¥0.021 · 12.4K tokens`, or a state word. */
  function inlineText(cost) {
    if (!cost || cost.state === 'pending') return '花费 …'
    if (cost.state === 'no-data') return '花费 无数据'
    if (cost.state === 'unpriced') return '花费 未定价'
    // Only money: the row already shows the turn's token count.
    return '花费 ≈' + formatMoney(cost.amount)
  }

  /**
   * Summarize an account balance payload into one display line.
   * @returns `{ state:'ready', amount, currency, text, bonus }`, `{state:'empty'}`,
   *          `{state:'failed'}` or `{state:'unavailable'}`.
   */
  function walletSummary(balance) {
    if (!balance) return { state: 'unavailable' }
    if (balance.status === 'failed') return { state: 'failed' }
    if (balance.status !== 'ready') return { state: 'unavailable' }
    var wallets = Array.isArray(balance.value) ? balance.value : []
    var bonus = Array.isArray(balance.bonusWallets) ? balance.bonusWallets : []
    if (wallets.length === 0 && bonus.length === 0) return { state: 'empty' }
    function pick(list) {
      if (list.length === 0) return undefined
      for (var i = 0; i < list.length; i += 1) if (list[i] && list[i].currency === 'CNY') return list[i]
      return list[0]
    }
    var wallet = pick(wallets)
    var bonusWallet = pick(bonus)
    var currency = (wallet && wallet.currency) || (bonusWallet && bonusWallet.currency) || 'CNY'
    var amount = wallet && typeof wallet.balance === 'string' ? wallet.balance : '0'
    var bonusAmount = bonusWallet && typeof bonusWallet.balance === 'string' ? bonusWallet.balance : undefined
    var symbol = currency === 'USD' ? '$' : '¥'
    var text = symbol + moneyText(amount)
    if (bonusAmount !== undefined && moneyText(bonusAmount) !== '0.00') {
      text = text + '（赠送 ' + symbol + moneyText(bonusAmount) + '）'
    }
    return { state: 'ready', amount: amount, currency: currency, symbol: symbol, text: text, bonus: bonusAmount }
  }

  /** Wallet strings arrive with full float precision; show two decimals. */
  function moneyText(raw) {
    var value = Number(raw)
    return isFinite(value) ? value.toFixed(2) : String(raw)
  }

  /** Validate a price table before it is saved; returns the offending fields. */
  function validatePrices(prices) {
    var errors = []
    if (!prices || typeof prices !== 'object' || !prices.models || typeof prices.models !== 'object') {
      return ['价格表结构不完整']
    }
    Object.keys(prices.models).forEach(function (model) {
      var entry = prices.models[model]
      ;['peak', 'offPeak'].forEach(function (band) {
        var row = entry && entry[band]
        if (!row) { errors.push(model + ' 缺少 ' + band); return }
        ;['cacheHit', 'cacheMiss', 'output'].forEach(function (field) {
          var value = row[field]
          if (typeof value !== 'number' || !isFinite(value) || value < 0) {
            errors.push(model + ' 的 ' + band + '.' + field + ' 必须是不小于 0 的数字')
          }
        })
      })
    })
    if (prices.holidays !== undefined && !Array.isArray(prices.holidays)) errors.push('holidays 必须是日期数组')
    return errors
  }

  /** Clean a raw input string into a non-negative number, or undefined. */
  function parseAmount(text) {
    if (typeof text === 'number') return isFinite(text) && text >= 0 ? text : undefined
    if (typeof text !== 'string' || text.trim() === '') return undefined
    var value = Number(text)
    return isFinite(value) && value >= 0 ? value : undefined
  }

  function budgetStatus(used, budget, thresholdPct) {
    if (!(typeof budget === 'number') || !isFinite(budget) || budget <= 0) return { state: 'unset' }
    var threshold = typeof thresholdPct === 'number' && thresholdPct > 0 && thresholdPct <= 100 ? thresholdPct : 80
    var amount = typeof used === 'number' && isFinite(used) ? used : 0
    var ratio = amount / budget
    return {
      state: 'set',
      used: amount,
      budget: budget,
      pct: Math.round(ratio * 1000) / 10,
      remaining: Math.max(0, budget - amount),
      over: amount - budget,
      level: amount > budget ? 'over' : ratio * 100 >= threshold ? 'warn' : 'ok',
    }
  }

  function csvCell(value) {
    var text = value === undefined || value === null ? '' : String(value)
    return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
  }

  /** CSV of the given rows plus one total line; header is fixed. */
  function toCsv(rows) {
    var lines = [['时间', '提问摘要', '模型', '未命中输入', '缓存命中', '输出', '金额'].join(',')]
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i]
      var cost = row.cost || {}
      lines.push([
        csvCell(row.timeText || ''),
        csvCell(row.prompt || ''),
        csvCell(cost.model || ''),
        csvCell(row.usage ? row.usage.uncachedInputTokens : ''),
        csvCell(row.usage && row.usage.cacheReadTokens !== undefined ? row.usage.cacheReadTokens : ''),
        csvCell(row.usage ? row.usage.outputTokens : ''),
        csvCell(cost.state === 'priced' ? cost.amount.toFixed(4) : (cost.state === 'unpriced' ? '未定价' : '无数据')),
      ].join(','))
    }
    var total = aggregate(rows)
    lines.push(['合计', '', '', '', '', '', total.amount.toFixed(2)].join(','))
    return lines.join('\n')
  }

  var CORE = {
    CURRENCY: CURRENCY,
    VERIFIED_DSH_VERSION: VERIFIED_DSH_VERSION,
    versionWarning: versionWarning,
    UNIT: UNIT,
    DEFAULT_PRICES: DEFAULT_PRICES,
    lastUsageChunk: lastUsageChunk,
    deriveTurnUsage: deriveTurnUsage,
    foldSession: foldSession,
    finalMessageId: finalMessageId,
    excerpt: excerpt,
    messageText: messageText,
    shanghaiParts: shanghaiParts,
    dateKey: dateKey,
    monthKey: monthKey,
    isPeak: isPeak,
    inView: inView,
    singleModel: singleModel,
    modelPrice: modelPrice,
    turnCost: turnCost,
    aggregate: aggregate,
    formatMoney: formatMoney,
    formatTotalMoney: formatTotalMoney,
    formatCompactTokens: formatCompactTokens,
    inlineText: inlineText,
    budgetStatus: budgetStatus,
    walletSummary: walletSummary,
    validatePrices: validatePrices,
    parseAmount: parseAmount,
    toCsv: toCsv,
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = CORE
  else root.__USAGE_COST_CORE__ = CORE
})(typeof globalThis !== 'undefined' ? globalThis : this)

;
/* Usage-cost UI: ledger, sidebar panel and the per-turn inline pill.
 *
 * Classic script. `window.__USAGE_COST_CORE__` is published by src/core.js,
 * which the build places just before this file inside the bundle factory.
 */
(function (root) {
  'use strict'

  var core = root.__USAGE_COST_CORE__
  var STORAGE_KEY = 'dsh.usage-cost.v1'
  var MAX_ROWS = 20000
  var PAGE_SIZE = 200

  function readStored() {
    try {
      var raw = root.localStorage.getItem(STORAGE_KEY)
      if (!raw) return null
      var value = JSON.parse(raw)
      if (!value || value.version !== 1 || !Array.isArray(value.rows)) return null
      return value
    } catch (error) {
      return null
    }
  }

  function nowMs() { return Date.now() }

  function keyOf(row) { return row.sessionId + '#' + row.turn }

  function formatTime(endedAt) {
    if (typeof endedAt !== 'number') return '—'
    var d = new Date(endedAt + 8 * 3600 * 1000)
    function p2(n) { return n < 10 ? '0' + n : String(n) }
    return p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes())
  }

  /** One ledger: rows, prices, budget, backfill progress, and live observations. */
  function createLedger(ctx, getRemote, getRemoteError) {
    var stored = readStored()
    var listeners = new Set()
    var observing = new Map()
    var buffers = new Map()
    var saveTimer = null
    var state = {
      prices: (stored && stored.prices) || core.DEFAULT_PRICES,
      budget: (stored && stored.budget) || { amount: 0, threshold: 80 },
      notices: (stored && stored.notices) || {},
      balance: (stored && stored.balance) || { state: 'unavailable' },
      rows: (stored && stored.rows) || [],
      status: 'idle',
      error: null,
      streamError: null,
      focus: null,
      progress: { done: 0, total: 0 },
      readCount: 0,
      diag: { inline: 0, inlineText: null, lastTurn: null, lastSessionId: null, found: false, hasRemote: null, at: 0 },
      backfilledAt: (stored && stored.backfilledAt) || null,
    }

    function emit() {
      // useSyncExternalStore compares snapshots by reference: publish a new
      // object, or an in-place mutation would never re-render the panel.
      state = Object.assign({}, state)
      listeners.forEach(function (listener) { listener() })
    }

    function subscribe(listener) {
      listeners.add(listener)
      return function () { listeners.delete(listener) }
    }

    function snapshot() { return state }

    function persist() {
      if (saveTimer !== null) return
      saveTimer = setTimeout(function () {
        saveTimer = null
        var payload = {
          version: 1, prices: state.prices, budget: state.budget, notices: state.notices,
          rows: state.rows, backfilledAt: state.backfilledAt, diag: state.diag,
          balance: state.balance,
        }
        try {
          root.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
        } catch (error) {
          // Quota or blocked storage: keep the newest half and try once.
          state.rows = state.rows.slice(-Math.floor(MAX_ROWS / 2))
          try {
            payload.rows = state.rows
            root.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
          } catch (ignored) { /* the session still shows in-memory numbers */ }
        }
      }, 400)
    }

    function mergeRows(rows) {
      var map = new Map()
      for (var i = 0; i < state.rows.length; i += 1) map.set(keyOf(state.rows[i]), state.rows[i])
      for (var j = 0; j < rows.length; j += 1) map.set(keyOf(rows[j]), rows[j])
      var merged = Array.from(map.values())
      merged.sort(function (a, b) { return (a.endedAt || 0) - (b.endedAt || 0) })
      state.rows = merged.slice(-MAX_ROWS)
    }

    function rowFor(sessionId, turn) {
      for (var i = state.rows.length - 1; i >= 0; i -= 1) {
        var row = state.rows[i]
        if (row.sessionId === sessionId && row.turn === turn) return row
      }
      return undefined
    }

    /**
     * The Turn row an action-row entry belongs to, keyed by its message id.
     *
     * `sessionId` narrows the search but is optional: the id is unique on its
     * own, and an entry that did not receive its Session must still resolve.
     */
    function rowForMessage(sessionId, messageId) {
      if (!messageId) return undefined
      for (var i = state.rows.length - 1; i >= 0; i -= 1) {
        var row = state.rows[i]
        if (row.messageId !== messageId) continue
        if (sessionId !== undefined && row.sessionId !== sessionId) continue
        return row
      }
      return undefined
    }

    /**
     * Remote methods answer with `{ ok, value }`.
     *
     * Reading the payload without unwrapping yields `undefined` instead of an
     * error, which looks like "no data" and hides the real refusal.
     */
    function unpack(response) {
      if (response && response.ok === false) {
        var error = response.error || {}
        var detail = error.message ? '：' + error.message : ''
        throw new Error('会话读取被拒绝：' + (error.code || 'unknown') + detail)
      }
      return response && response.ok === true ? response.value : response
    }

    function eventsOf(records) {
      var events = []
      for (var i = 0; i < records.length; i += 1) {
        var record = records[i]
        if (record && record.event) events.push(record.event)
        else if (record && record.type) events.push(record)
      }
      return events
    }

    function rowsOfSession(summary, events) {
      var folded = core.foldSession(events)
      var rows = []
      for (var i = 0; i < folded.length; i += 1) {
        var row = folded[i]
        if (row.endedAt === undefined) continue
        rows.push({
          sessionId: summary.sessionId,
          turn: row.turn,
          endedAt: row.endedAt,
          prompt: row.prompt,
          usage: row.usage || null,
          messageId: row.messageId,
          subagent: summary.origin === 'subagent',
          workspace: summary.cwd || '',
        })
      }
      return rows
    }

    var loadedSessions = new Set()
    var inflight = new Map()

    /**
     * Read one session's history so its Turns have amounts.
     *
     * `force` re-reads a session already read once. The inline amount needs it:
     * a Turn that just finished is not in the ledger yet, and the action row
     * must not keep showing a placeholder until the next full backfill.
     */
    function loadSession(sessionId, force) {
      if (!hasRemote() || !sessionId) return Promise.resolve()
      if (!force && loadedSessions.has(sessionId)) return Promise.resolve()
      var running = inflight.get(sessionId)
      if (running) return running
      var task = (async function () {
        try {
          var rows = await readSession({ sessionId: sessionId }, new AbortController().signal)
          mergeRows(rows)
          persist()
          emit()
          loadedSessions.add(sessionId)
        } catch (error) {
          state.error = String((error && error.message) || error)
          emit()
        } finally {
          inflight.delete(sessionId)
        }
      })()
      inflight.set(sessionId, task)
      return task
    }

    function ensureSession(sessionId) { return loadSession(sessionId, false) }

    /** Re-read regardless of the once-per-session cache: a new Turn arrived. */
    function refresh(sessionId) { return loadSession(sessionId, true) }

    /**
     * Mark one Turn so the panel can lead with it.
     *
     * The panel is a different seat from the action row and cannot scroll to a
     * row it does not own; naming the Turn is what "locate this Turn" means
     * here. Returns false when the Turn is not in the ledger yet.
     */
    function focusTurn(sessionId, messageId) {
      var row = rowForMessage(sessionId, messageId)
      if (row === undefined) return false
      state.focus = { sessionId: row.sessionId, turn: row.turn }
      emit()
      return true
    }

    function clearFocus() {
      if (state.focus === null) return
      state.focus = null
      emit()
    }

    async function readSession(summary, signal) {
      var collected = []
      var seen = new Set()
      var beforeSeq
      for (var page = 0; page < 200; page += 1) {
        var request = { address: { kind: 'session', sessionId: summary.sessionId }, maxMessages: PAGE_SIZE }
        if (beforeSeq !== undefined) request.beforeSeq = beforeSeq
        var result = unpack(await remoteSession().events(request, signal))
        var records = (result && result.records) || []
        for (var i = records.length - 1; i >= 0; i -= 1) {
          var event = records[i] && records[i].event
          if (!event || seen.has(event.seq)) continue
          seen.add(event.seq)
          collected.unshift(event)
        }
        if (!result || !result.hasMore || records.length === 0) break
        beforeSeq = records[0].event.seq
      }
      return rowsOfSession(summary, collected)
    }

    async function backfill() {
      if (state.status === 'loading') return
      setDiag({ hasRemote: hasRemote() })
      if (!hasRemote()) {
        state.status = 'error'
        state.error = '会话读取接口不可用' + remoteReason()
        emit()
        return
      }
      state.status = 'loading'
      state.error = null
      emit()
      var controller = new AbortController()
      controllerRef = controller
      try {
        var listed = unpack(await remoteSession().list({}, controller.signal))
        var items = (listed && listed.items) || []
        state.progress = { done: 0, total: items.length }
        emit()
        for (var i = 0; i < items.length; i += 1) {
          var item = items[i]
          if (!item.blank) {
            try {
              var rows = await readSession(item, controller.signal)
              mergeRows(rows)
            } catch (error) {
              state.error = String((error && error.message) || error)
            }
          }
          state.progress = { done: i + 1, total: items.length }
          if (!item.blank) state.readCount = (state.readCount || 0) + 1
          persist()
          emit()
        }
        state.status = 'ready'
        state.backfilledAt = nowMs()
        setDiag({ status: 'ready', readCount: state.readCount, rowCount: state.rows.length })
        persist()
        emit()
      } catch (error) {
        state.status = 'error'
        state.error = String((error && error.message) || error)
        setDiag({ status: 'error', error: state.error })
        emit()
      }
    }

    var balanceReader = null

    /** Install the account-balance reader provided by the plugin half. */
    function setBalanceReader(reader) { balanceReader = reader }

    /** Read the account wallet once and publish a display summary. */
    async function refreshBalance() {
      if (typeof balanceReader !== 'function') {
        state.balance = { state: 'unavailable' }
        setDiag({ balance: 'unavailable' })
        emit()
        return
      }
      try {
        var result = await balanceReader()
        var summary = result && result.ok ? core.walletSummary(result.value) : { state: 'failed' }
        state.balance = summary
        setDiag({ balance: summary.state === 'ready' ? summary.text : summary.state })
        persist()
        emit()
      } catch (error) {
        state.balance = { state: 'failed' }
        setDiag({ balance: 'failed' })
        emit()
      }
    }

    var controllerRef = null

    function observe(summary) {
      if (observing.has(summary.sessionId) || !hasRemote()) return
      var controller = new AbortController()
      observing.set(summary.sessionId, controller)
      var buffer = buffers.get(summary.sessionId) || []
      buffers.set(summary.sessionId, buffer)
      ;(async function () {
        try {
          var stream = remoteSession().observeEvent({ address: { kind: 'session', sessionId: summary.sessionId } }, controller.signal)
          // The live stream is an optimization; the ledger is already correct
          // through readSession. A host that returns a handle instead of an
          // iterable must not turn the panel into an error page.
          if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return
          for await (var frame of stream) {
            if (!frame || frame.type !== 'event' || !frame.event) continue
            buffer.push(frame.event)
            if (buffer.length > 5000) buffer.splice(0, buffer.length - 5000)
            if (frame.event.type === 'turn/end') {
              mergeRows(rowsOfSession(summary, buffer))
              persist()
              emit()
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            // Kept off `state.error`: a stream that cannot open must not
            // report the feature as broken while pull reads still work.
            state.streamError = String((error && error.message) || error)
            emit()
          }
        }
      })()
    }

    function dispose() {
      observing.forEach(function (controller) { controller.abort() })
      observing.clear()
      if (controllerRef) controllerRef.abort()
      if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null }
    }

    function decoratedRows(view) {
      var now = nowMs()
      var rows = []
      for (var i = 0; i < state.rows.length; i += 1) {
        var row = state.rows[i]
        if (typeof row.endedAt !== 'number') continue
        if (!core.inView(row.endedAt, view, now)) continue
        var routes = row.usage && row.usage.routes
        var cost = core.turnCost(row.usage, routes, row.endedAt, state.prices)
        rows.push({
          sessionId: row.sessionId,
          turn: row.turn,
          endedAt: row.endedAt,
          timeText: formatTime(row.endedAt),
          prompt: row.prompt,
          usage: row.usage,
          cost: cost,
          subagent: row.subagent,
          model: cost.model || (routes && routes[0] && routes[0].model) || '',
        })
      }
      rows.sort(function (a, b) { return b.endedAt - a.endedAt })
      return rows
    }

    function monthTotal() {
      var rows = decoratedRows('month')
      return core.aggregate(rows)
    }

    function setPrices(prices) { state.prices = prices; persist(); emit() }
    function setBudget(budget) { state.budget = budget; persist(); emit() }

    /** Record what the inline pill actually saw; the Host can read the stored payload. */
    function noteInline(entry) {
      state.diag = Object.assign({}, state.diag, entry, { at: Date.now() })
      persist()
    }

    function setDiag(patch) {
      state.diag = Object.assign({}, state.diag, patch, { at: Date.now() })
    }

    function isNotified(key) { return key !== '' && state.notices[key] === true }
    function dismissNotice(key) {
      if (key) state.notices[key] = true
      persist()
      emit()
    }

    /** Why the last lookup of `remote` failed, as a readable suffix. */
    function remoteReason() {
      var reason = null
      try { reason = getRemoteError && getRemoteError() } catch (error) { reason = null }
      return reason ? '：' + reason : ''
    }

    /** Probe the session remote without tripping Cordis's un-injected proxy.
     *
     * Resolved on every call: `remote` arrives before its `session` namespace,
     * so a value captured once at apply time can be stale forever.
     */
    function remoteSession() {
      try {
        var remote = getRemote()
        return remote && remote.session ? remote.session : undefined
      } catch (error) {
        return undefined
      }
    }

    function hasRemote() { return remoteSession() !== undefined }

    return {
      hasRemote: hasRemote,
      remoteReason: remoteReason,
      subscribe: subscribe,
      snapshot: snapshot,
      backfill: backfill,
      observe: observe,
      ensureSession: ensureSession,
      refresh: refresh,
      focusTurn: focusTurn,
      clearFocus: clearFocus,
      rowFor: rowFor,
      rowForMessage: rowForMessage,
      decoratedRows: decoratedRows,
      monthTotal: monthTotal,
      setPrices: setPrices,
      setBudget: setBudget,
      isNotified: isNotified,
      noteInline: noteInline,
      setDiag: setDiag,
      setBalanceReader: setBalanceReader,
      refreshBalance: refreshBalance,
      dismissNotice: dismissNotice,
      dispose: dispose,
    }
  }

  /** Subscribe through useState: works on every React build the page may expose. */
  function useLedger(React, ledger) {
    var pair = React.useState(function () { return ledger.snapshot() })
    var snapshot = pair[0]
    var setSnapshot = pair[1]
    React.useEffect(function () {
      return ledger.subscribe(function () { setSnapshot(ledger.snapshot()) })
    }, [ledger])
    return snapshot
  }

  var CSS = [
    '.uc-page{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}',
    '.uc-scroll{flex:1;min-height:0;overflow:auto}',
    '.uc-inner{max-width:1040px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px}',
    '.uc-head{padding-top:28px;margin-bottom:18px}',
    "[data-platform='darwin'] .uc-head{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}",
    '.uc-title{display:flex;align-items:baseline;gap:10px;margin:0;font-size:20px;line-height:28px;font-weight:500}',
    '.uc-sub{margin:6px 0 0;font-size:13px;color:var(--dsw-alias-label-secondary)}',
    '.uc-tabs{display:flex;gap:4px;margin:18px 0 12px}',
    '.uc-tab{height:28px;padding:0 12px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}',
    '.uc-tab:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
    '.uc-tab[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}',
    '.uc-tab:focus-visible,.uc-btn:focus-visible,.uc-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
    '.uc-sum{display:flex;flex-wrap:wrap;gap:24px;padding:14px 16px;margin-bottom:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
    '.uc-sum-item{display:flex;flex-direction:column;gap:2px;min-width:96px}',
    '.uc-sum-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
    '.uc-sum-value{font-size:18px;font-weight:500}',
    '.uc-note{font-size:12px;color:var(--dsw-alias-label-secondary)}',
    '.uc-warn{color:var(--dsw-alias-state-error-primary)}',
    '.uc-hint{font-size:12px;color:var(--dsw-alias-state-warn-primary)}',
    '.uc-table{width:100%;border-collapse:collapse;font-size:13px}',
    '.uc-table th{position:sticky;top:0;background:var(--dsw-alias-bg-base);text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
    '.uc-table td{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}',
    '.uc-table tr:hover td{background:var(--dsw-alias-bg-layer-1)}',
    '.uc-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.uc-prompt{max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.uc-tag{display:inline-block;padding:0 6px;margin-left:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
    '.uc-empty{padding:40px 0;text-align:center;color:var(--dsw-alias-label-secondary)}',
    '.uc-btn{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
    '.uc-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
    // Sits inside the Turn action row beside the icon buttons: borderless,
    // never stretched, and digits aligned so the amount does not jitter.
    '.uc-inline{display:inline-flex;align-items:baseline;gap:2px;padding:0;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:inherit;white-space:nowrap;font-variant-numeric:tabular-nums;cursor:pointer;}',
    '.uc-head-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;justify-content:space-between}',
    '.uc-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}',
    '.uc-section{margin:0 0 16px;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
    '.uc-section-title{margin:0 0 12px;font-size:14px;font-weight:500}',
    '.uc-price-row{display:grid;grid-template-columns:140px repeat(3,minmax(0,1fr));gap:8px;align-items:end;margin-bottom:10px}',
    '.uc-price-model{font-size:13px;user-select:text;padding-bottom:6px}',
    '.uc-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
    '.uc-field.uc-wide{margin-top:12px}',
    '.uc-input{height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;box-sizing:border-box}',
    '.uc-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
    '.uc-textarea{height:72px;padding:6px 8px;resize:vertical}',
    '.uc-banner{display:flex;align-items:center;gap:12px;justify-content:space-between;padding:10px 12px;margin-bottom:12px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:10px;font-size:13px}',
    '.uc-progress{height:6px;margin:10px 0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
    '.uc-progress-bar{height:100%;background:var(--dsw-alias-brand-primary)}',
    '.uc-inline:hover{color:var(--dsw-alias-label-primary);text-decoration:underline;text-underline-offset:2px;}',
    '.uc-focus{display:flex;align-items:center;gap:12px;justify-content:space-between;padding:8px 12px;margin-bottom:12px;border:1px solid var(--dsw-alias-brand-primary);border-radius:10px;font-size:13px}',
    '.uc-row-focus{background:var(--dsw-alias-bg-layer-2)}',
  ].join('')

  function createUi(React, ctx, ledger, layout) {
    var h = React.createElement

    /** The release the page booted, when the boot manifest exposes it. */
    function runningRelease() {
      try {
        var boot = root.__DSH_BOOT__
        var release = boot && boot.release
        return release && typeof release.version === 'string' ? release.version : ''
      } catch (error) {
        return ''
      }
    }

    /** Render the given tree, or a readable error line instead of a blank seat. */
    function renderSafely(build) {
      try {
        return build()
      } catch (error) {
        return h('div', { className: 'uc-empty uc-warn' }, '用量面板渲染出错：' + String((error && error.message) || error))
      }
    }
    var VIEWS = [['today', '今日'], ['month', '本月'], ['year', '本年'], ['all', '全部']]

    function useSnapshot() { return useLedger(React, ledger) }

    var FIELD_LABELS = { cacheHit: '命中', cacheMiss: '未命中', output: '输出' }

    function Panel() {
      var snap = useSnapshot()
      var viewPair = React.useState('today')
      var view = viewPair[0]
      var setView = viewPair[1]
      var sectionPair = React.useState(null)
      var section = sectionPair[0]
      var setSection = sectionPair[1]
      var noticePair = React.useState('')
      var notice = noticePair[0]
      var setNotice = noticePair[1]
      var draftPair = React.useState(null)
      var draft = draftPair[0]
      var setDraft = draftPair[1]

      React.useEffect(function () {
        if (ledger.snapshot().status === 'idle') ledger.backfill()
        ledger.refreshBalance()
      }, [])

      // A locate request must land on a row the table actually shows: widen the
      // range before painting, or an old Turn stays filtered out of "today".
      React.useEffect(function () {
        if (snap.focus !== null) setView('all')
      }, [snap.focus])

      var rows = ledger.decoratedRows(view)
      var total = core.aggregate(rows)
      var budget = core.budgetStatus(ledger.monthTotal().amount, snap.budget.amount, snap.budget.threshold)
      var noticeKey = budget.state === 'set'
        ? core.monthKey(Date.now()) + ':' + snap.budget.threshold + ':' + snap.budget.amount
        : ''
      // The Turn an inline amount asked the panel to lead with, when it exists.
      // Built from the raw row, not from `rows`: the focused Turn may be
      // filtered out of the current view and must still be describable.
      var focusedRow
      if (snap.focus !== null) {
        var focusedRaw = ledger.rowFor(snap.focus.sessionId, snap.focus.turn)
        if (focusedRaw !== undefined) {
          focusedRow = {
            timeText: formatTime(focusedRaw.endedAt),
            prompt: focusedRaw.prompt,
            cost: core.turnCost(focusedRaw.usage, focusedRaw.usage && focusedRaw.usage.routes, focusedRaw.endedAt, snap.prices),
          }
        }
      }

      function openPrices() {
        if (section === 'prices') { setSection(null); return }
        setDraft(JSON.parse(JSON.stringify(snap.prices)))
        setSection('prices')
      }

      function openBudget() {
        setSection(section === 'budget' ? null : 'budget')
      }

      function exportView() {
        try {
          var blob = new Blob([core.toCsv(rows)], { type: 'text/csv;charset=utf-8' })
          var url = URL.createObjectURL(blob)
          var link = document.createElement('a')
          link.href = url
          link.download = 'usage-cost-' + view + '.csv'
          link.click()
          // Revoking in the same tick can cancel the download before the
          // browser has read the blob; give it a turn of the event loop.
          setTimeout(function () { URL.revokeObjectURL(url) }, 0)
        } catch (error) {
          setNotice('导出失败：' + String((error && error.message) || error))
        }
      }

      function priceEditor() {
        var models = Object.keys((draft && draft.models) || {})
        return h('div', { className: 'uc-section' },
          h('h2', { className: 'uc-section-title' }, '价格表（元 / 百万 tokens）'),
          models.map(function (model) {
            return h('div', { className: 'uc-price-row', key: model },
              h('div', { className: 'uc-price-model' }, model),
              ['peak', 'offPeak'].map(function (band) {
                return ['cacheHit', 'cacheMiss', 'output'].map(function (field) {
                  return h('label', { className: 'uc-field', key: band + field },
                    h('span', null, (band === 'peak' ? '高峰' : '空闲') + ' ' + FIELD_LABELS[field]),
                    h('input', {
                      className: 'uc-input', type: 'number', min: '0', step: '0.01',
                      value: draft.models[model][band][field],
                      onChange: function (event) {
                        var next = JSON.parse(JSON.stringify(draft))
                        var parsed = core.parseAmount(event.target.value)
                        next.models[model][band][field] = parsed === undefined ? 0 : parsed
                        setDraft(next)
                      },
                    }))
                })
              }))
          }),
          h('label', { className: 'uc-field uc-wide' },
            h('span', null, '节假日（每行一个 YYYY-MM-DD，用于区分高峰/空闲）'),
            h('textarea', {
              className: 'uc-input uc-textarea',
              value: (draft && draft.holidays ? draft.holidays : []).join('\n'),
              onChange: function (event) {
                var next = JSON.parse(JSON.stringify(draft))
                next.holidays = event.target.value.split('\n').map(function (line) { return line.trim() }).filter(Boolean)
                setDraft(next)
              },
            })),
          h('div', { className: 'uc-actions' },
            h('button', {
              className: 'uc-btn', type: 'button',
              onClick: function () {
                var errors = core.validatePrices(draft)
                if (errors.length > 0) { setNotice('价格表有误：' + errors.join('；')); return }
                ledger.setPrices(draft)
                setNotice('价格表已保存，历史金额按新价重算')
                setSection(null)
              },
            }, '保存'),
            h('button', {
              className: 'uc-btn', type: 'button',
              onClick: function () { setDraft(JSON.parse(JSON.stringify(core.DEFAULT_PRICES))) },
            }, '恢复默认'),
            h('button', { className: 'uc-btn', type: 'button', onClick: function () { setSection(null) } }, '取消')))
      }

      function budgetEditor() {
        return h('div', { className: 'uc-section' },
          h('h2', { className: 'uc-section-title' }, '月度预算'),
          h('div', { className: 'uc-price-row' },
            h('label', { className: 'uc-field' },
              h('span', null, '预算金额（元）'),
              h('input', {
                className: 'uc-input', type: 'number', min: '0', step: '1',
                value: snap.budget.amount || '',
                onChange: function (event) {
                  var amount = core.parseAmount(event.target.value)
                  ledger.setBudget({ amount: amount === undefined ? 0 : amount, threshold: snap.budget.threshold })
                },
              })),
            h('label', { className: 'uc-field' },
              h('span', null, '提醒阈值（%）'),
              h('input', {
                className: 'uc-input', type: 'number', min: '1', max: '100', step: '5',
                value: snap.budget.threshold || '',
                onChange: function (event) {
                  var threshold = core.parseAmount(event.target.value)
                  ledger.setBudget({
                    amount: snap.budget.amount,
                    threshold: threshold === undefined ? 80 : Math.min(100, Math.max(1, threshold)),
                  })
                },
              }))),
          budget.state === 'set'
            ? h('div', null,
              h('div', { className: 'uc-progress' },
                h('div', { className: 'uc-progress-bar', style: { width: Math.min(100, Math.max(0, budget.pct)) + '%' } })),
              h('div', { className: 'uc-note' },
                '本月已用 ' + core.formatTotalMoney(budget.used) + ' / ' + core.formatTotalMoney(budget.budget)
                + '（' + budget.pct + '%）· 剩余 ' + core.formatTotalMoney(budget.remaining)))
            : h('p', { className: 'uc-note' }, '还没有设置预算。每月按自然月计算。'),
          h('div', { className: 'uc-actions' },
            h('button', {
              className: 'uc-btn', type: 'button',
              onClick: function () { ledger.setBudget({ amount: 0, threshold: 80 }) },
            }, '清除预算'),
            h('button', { className: 'uc-btn', type: 'button', onClick: function () { setSection(null) } }, '关闭')))
      }

      var banner = null
      if (budget.state === 'set' && budget.level !== 'ok' && !ledger.isNotified(noticeKey)) {
        banner = h('div', { className: 'uc-banner' },
          h('span', null, budget.level === 'over'
            ? '本月已超出预算 ' + core.formatTotalMoney(budget.over)
            : '本月已用 ' + budget.pct + '%，接近预算'),
          h('button', { className: 'uc-btn', type: 'button', onClick: function () { ledger.dismissNotice(noticeKey) } }, '知道了'))
      } else if (notice !== '') {
        banner = h('div', { className: 'uc-banner' },
          h('span', null, notice),
          h('button', { className: 'uc-btn', type: 'button', onClick: function () { setNotice('') } }, '关闭'))
      }

      var summaryItems = [
        h('div', { className: 'uc-sum-item', key: 'amount' },
          h('span', { className: 'uc-sum-label' }, '合计金额（估算）'),
          h('span', { className: 'uc-sum-value' }, core.formatTotalMoney(total.amount))),
        h('div', { className: 'uc-sum-item', key: 'tokens' },
          h('span', { className: 'uc-sum-label' }, '合计 tokens'),
          h('span', { className: 'uc-sum-value' }, core.formatCompactTokens(total.tokens))),
        h('div', { className: 'uc-sum-item', key: 'turns' },
          h('span', { className: 'uc-sum-label' }, '轮次'),
          h('span', { className: 'uc-sum-value' }, String(total.turns))),
      ]
      if (total.unpriced > 0) {
        summaryItems.push(h('div', { className: 'uc-sum-item', key: 'unpriced' },
          h('span', { className: 'uc-sum-label' }, '未定价'),
          h('span', { className: 'uc-sum-value uc-warn' }, String(total.unpriced))))
      }
      var balance = snap.balance || { state: 'unavailable' }
      summaryItems.push(h('div', { className: 'uc-sum-item', key: 'balance' },
        h('span', { className: 'uc-sum-label' }, '账户余额'),
        h('span', {
          className: 'uc-sum-value' + (balance.state === 'failed' ? ' uc-warn' : ''),
          title: balance.state === 'failed' ? '读取账户余额失败' : (balance.state === 'unavailable' ? '当前 DSH 没有暴露账户余额接口' : '充值余额 + 赠送余额'),
        }, balance.state === 'ready' ? balance.text : (balance.state === 'failed' ? '读取失败' : (balance.state === 'empty' ? '—' : '不可用')))))

      if (budget.state === 'set') {
        summaryItems.push(h('div', { className: 'uc-sum-item', key: 'budget' },
          h('span', { className: 'uc-sum-label' }, '本月预算'),
          h('span', { className: 'uc-sum-value' + (budget.level === 'ok' ? '' : ' uc-warn') }, budget.pct + '%'),
          h('span', { className: 'uc-note' }, '剩余 ' + core.formatTotalMoney(budget.remaining))))
      }

      var body
      if (snap.status === 'loading') {
        body = h('div', { className: 'uc-empty' }, '正在读取会话记录 ' + snap.progress.done + '/' + snap.progress.total + ' …')
      } else if (snap.status === 'error') {
        body = h('div', { className: 'uc-empty uc-warn' }, '读取失败：' + snap.error)
      } else if (rows.length === 0) {
        body = h('div', { className: 'uc-empty' }, snap.status === 'idle' ? '还没有读取数据，点右上角「刷新」开始。' : '这个范围内还没有轮次。')
      } else {
        body = h('table', { className: 'uc-table' },
          h('thead', null, h('tr', null,
            h('th', null, '时间'), h('th', null, '提问'), h('th', null, '模型'),
            h('th', { className: 'uc-num' }, '未命中'), h('th', { className: 'uc-num' }, '缓存命中'),
            h('th', { className: 'uc-num' }, '输出'), h('th', { className: 'uc-num' }, '金额'))),
          h('tbody', null, rows.map(function (row) {
            var isFocused = snap.focus !== null && snap.focus.sessionId === row.sessionId && snap.focus.turn === row.turn
            return h('tr', { key: row.sessionId + '#' + row.turn, className: isFocused ? 'uc-row-focus' : undefined },
              h('td', null, row.timeText),
              h('td', { className: 'uc-prompt', title: row.prompt }, row.prompt || '（无提问文本）',
                row.subagent ? h('span', { className: 'uc-tag' }, '子任务') : null),
              h('td', null, row.model || '—'),
              h('td', { className: 'uc-num' }, row.usage ? String(row.usage.uncachedInputTokens + (row.usage.cacheWriteTokens || 0)) : '—'),
              h('td', { className: 'uc-num' }, row.usage && row.usage.cacheReadTokens !== undefined ? String(row.usage.cacheReadTokens) : '—'),
              h('td', { className: 'uc-num' }, row.usage ? String(row.usage.outputTokens) : '—'),
              h('td', { className: 'uc-num' }, row.cost.state === 'priced' ? core.formatMoney(row.cost.amount) : (row.cost.state === 'unpriced' ? '未定价' : '无数据')))
          })))
      }

      try {
        var panelSeen = (ledger.snapshot().diag && ledger.snapshot().diag.panelRenders) || 0
        ledger.setDiag({ panelRenders: panelSeen + 1, panelRows: rows.length, panelView: view })
      } catch (error) { /* diagnostics must never break rendering */ }

      return renderSafely(function () {
        return h('section', { className: 'uc-page' },
          h('style', null, CSS),
          h('div', { className: 'uc-scroll' },
            h('div', { className: 'uc-inner' },
              h('header', { className: 'uc-head' },
                h('div', { className: 'uc-head-row' },
                  h('h1', { className: 'uc-title' }, '用量估计'),
                  h('div', { className: 'uc-actions' },
                    h('button', {
                      className: 'uc-btn', type: 'button',
                      onClick: function () { ledger.backfill(); ledger.refreshBalance() },
                    }, '刷新'),
                    h('button', { className: 'uc-btn', type: 'button', onClick: openPrices }, '价格表'),
                    h('button', { className: 'uc-btn', type: 'button', onClick: openBudget }, '预算'),
                    h('button', { className: 'uc-btn', type: 'button', onClick: exportView }, '导出 CSV'))),
                h('p', { className: 'uc-sub' }, '按 DeepSeek 公开单价估算，不等于官方账单。数据只读自本机会话记录。'),
                h('p', { className: 'uc-note' },
                  '诊断：接口 ' + (ledger.hasRemote() ? '可用' : '不可用' + ledger.remoteReason())
                  + ' · 状态 ' + snap.status
                  + ' · 已读 ' + (snap.readCount || 0) + ' 个会话'
                  + ' · ' + snap.rows.length + ' 轮'
                  + ' · id 覆盖 ' + snap.rows.filter(function (row) { return typeof row.messageId === 'string' }).length + '/' + snap.rows.length
                  + (snap.streamError ? ' · 实时流不可用' : '')
                  + (snap.error ? ' · 错误：' + snap.error : '')),
                core.versionWarning(runningRelease(), core.VERIFIED_DSH_VERSION) === null ? null
                  : h('p', { className: 'uc-note uc-hint' }, core.versionWarning(runningRelease(), core.VERIFIED_DSH_VERSION))),
              banner,
              snap.focus === null ? null : h('div', { className: 'uc-focus' },
                h('span', null, focusedRow
                  ? '定位：' + focusedRow.timeText + ' · ' + (focusedRow.prompt || '（无提问文本）') + ' · '
                    + (focusedRow.cost.state === 'priced' ? core.formatMoney(focusedRow.cost.amount) : (focusedRow.cost.state === 'unpriced' ? '未定价' : '无数据'))
                  : '定位：第 ' + snap.focus.turn + ' 轮还不在账本里'),
                h('button', { className: 'uc-btn', type: 'button', onClick: function () { ledger.clearFocus() } }, '清除定位')),
              section === 'prices' ? priceEditor() : null,
              section === 'budget' ? budgetEditor() : null,
              h('div', { className: 'uc-tabs' }, [['today', '今日'], ['month', '本月'], ['year', '本年'], ['all', '全部']].map(function (pair) {
                return h('button', {
                  key: pair[0], type: 'button', className: 'uc-tab',
                  'aria-pressed': view === pair[0] ? 'true' : 'false',
                  onClick: function () { setView(pair[0]) },
                }, pair[1])
              })),
              h('div', { className: 'uc-sum' }, summaryItems),
              body)))
      })
    }

    function Inline(props) {
      useSnapshot()
      // Pull, do not wait for a stream: a Turn that just ended is not in the
      // ledger yet, and its action row mounts immediately.
      React.useEffect(function () {
        if (!props.messageId || !props.sessionId) return
        var sessionId = props.sessionId
        var messageId = props.messageId
        var timer = null
        var attempts = 0
        var cancelled = false

        function settle() {
          if (cancelled) return
          if (ledger.rowForMessage(sessionId, messageId)) {
            ledger.observe({ sessionId: sessionId })
            return
          }
          // One retry only: the row can mount before the log holds turn/end.
          if (attempts >= 1) return
          attempts += 1
          timer = setTimeout(function () {
            timer = null
            if (cancelled) return
            ledger.refresh(sessionId).then(settle, settle)
          }, 1500)
        }

        ledger.refresh(sessionId).then(settle, settle)
        return function () {
          cancelled = true
          if (timer !== null) clearTimeout(timer)
        }
      }, [props.sessionId, props.messageId])
      var row
      var cost
      var text
      var title
      try {
        row = props.messageId === undefined ? undefined : ledger.rowForMessage(props.sessionId, props.messageId)
        cost = row ? core.turnCost(row.usage, row.usage && row.usage.routes, row.endedAt, ledger.snapshot().prices) : { state: 'pending' }
        text = core.inlineText(cost)
        title = inlineTitle(props, row, cost)
      } catch (error) {
        // Render a marker instead of vanishing: a blank seat is indistinguishable
        // from a seat that never mounted.
        text = '¥?'
        title = '计算金额时出错：' + String((error && error.message) || error)
      }
      try {
        var seen = ledger.snapshot().diag || {}
        ledger.noteInline({
          inline: (seen.inline || 0) + 1,
          inlineText: text,
          lastMessageId: props.messageId,
          lastSessionId: props.sessionId,
          found: !!row,
          hasRemote: ledger.hasRemote(),
          inlineStyle: 'plain-text',
          inlinePlace: 'row-end',
        })
      } catch (error) { /* diagnostics must never break rendering */ }

      // A span, not a button: the action row already has its own icon buttons,
      // and a bare <button> inherits the browser's boxed chrome. Inline styles are
      // deliberate — the row can render before the panel ever mounts its stylesheet.
      const style = {
        border: 0,
        background: 'none',
        padding: '0 2px',
        margin: 0,
        color: 'var(--dsw-alias-label-secondary)',
        font: 'inherit',
        fontSize: 12,
        lineHeight: 'inherit',
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
        cursor: 'pointer',
        // The action row is a flex container: a positive order seats this after
        // the built-in end info (usage pill + clock), which is the only place a
        // slot entry can reach that is right of the usage readout.
        order: 9,
        marginLeft: 0,
      }
      const open = () => {
        try {
          if (layout) layout.selectPanel('usage-cost')
        } catch (error) { /* the panel seat is unavailable; the pill stays inert */ }
        try { ledger.focusTurn(props.sessionId, props.messageId) } catch (error) { /* ignore */ }
      }
      return h('span', {
        role: 'button',
        tabIndex: 0,
        className: 'uc-inline',
        style: style,
        title: title,
        onClick: open,
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          open()
        },
      }, text)
    }

    /**
     * Say why the amount is not there yet.
     *
     * A placeholder with no reason is indistinguishable from a broken lookup;
     * hovering must name which of the four states this entry is in.
     */
    function inlineTitle(props, row, cost) {
      if (props.messageId === undefined) return '这一条没有消息 id，无法定位到轮次'
      if (!row) return '还没读到这一轮的用量，正在重试；点击打开用量面板'
      if (cost.state === 'priced') {
        return '≈' + core.formatMoney(cost.amount) + ' · ' + core.formatCompactTokens(cost.tokens) + '（估算，点击打开用量面板）'
      }
      if (cost.state === 'unpriced') return '这一轮的模型不在价目表里；点击打开用量面板'
      return '这一轮没有可用的用量数据；点击打开用量面板'
    }

    return { Panel: Panel, Inline: Inline }
  }

  root.__USAGE_COST_UI__ = { createLedger: createLedger, createUi: createUi, CSS: CSS }
})(typeof globalThis !== 'undefined' ? globalThis : this)

;
    /* Registration half, placed inside the bundle factory by scripts/build.mjs. */
    const React = require('react')
    const CORE = window.__USAGE_COST_CORE__
    const UI = window.__USAGE_COST_UI__
    const PANEL_ID = 'usage-cost'

    /** Optional service lookup: Cordis throws for a strict miss, a plugin must not. */
    function optional(ctx, name) {
      try {
        return ctx.get(name)
      } catch (error) {
        return undefined
      }
    }

    /** Sidebar glyph: three rising bars, drawn at the edge the sidebar asks for. */
    function Icon({ size }) {
      return React.createElement('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      React.createElement('path', { key: 'a', d: 'M6 20v-5' }),
      React.createElement('path', { key: 'b', d: 'M12 20v-9' }),
      React.createElement('path', { key: 'c', d: 'M18 20v-14' }))
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.session', 'layout'],
      apply(ctx) {
        // Resolved lazily: `remote` is provided before its `session` namespace
        // is mounted, so a value captured here can miss the namespace forever.
        // The failure is kept, not swallowed: "不可用" alone is unactionable.
        let remoteError = null
        const getRemote = () => {
          try {
            const remote = ctx.get('remote')
            remoteError = remote === undefined ? 'ctx.get("remote") 返回 undefined' : null
            return remote
          } catch (error) {
            remoteError = String((error && error.message) || error)
            return undefined
          }
        }
        const layout = optional(ctx, 'layout')
        const ledger = UI.createLedger(ctx, getRemote, () => remoteError)

        /** Client metadata the account Remote requires. */
        const accountMetadata = () => {
          let locale = 'zh'
          try { locale = String(ctx.locale.getSnapshot().active || 'zh').split('-')[0] } catch (error) { /* keep default */ }
          let version = '0.0.0'
          try {
            version = (window.__DSH_BOOT__ && window.__DSH_BOOT__.release && window.__DSH_BOOT__.release.version) || '0.0.0'
          } catch (error) { /* keep default */ }
          return {
            version: version,
            locale: locale,
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          }
        }

        // Optional on purpose: a profile without account login must not block the
        // panel, and `remote.account` is only reachable when it is declared.
        ctx.inject(['remote.account'], (scoped) => {
          ledger.setBalanceReader(function () {
            return scoped.remote.account.getBalance(accountMetadata())
          })
          ledger.refreshBalance()
        })
        const ui = UI.createUi(React, ctx, ledger, layout)

        ctx.effect(() => () => { ledger.dispose() }, 'usage-cost: ledger')

        // Fill the ledger as soon as the page loads, not only when the panel is
        // opened: the inline pill reads from it and must have numbers already.
        // The session namespace may mount after this plugin, so retry briefly.
        let attempts = 0
        const kick = () => {
          if (ledger.hasRemote()) { ledger.backfill(); return }
          if (attempts >= 30) { ledger.setDiag({ backfillNeverReady: true }); return }
          attempts += 1
          setTimeout(kick, 1000)
        }
        kick()

        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          label: '用量估计',
        }, Icon)), 'usage-cost: sidebar entry')

        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, ui.Panel)), 'usage-cost: panel')

        // Not `conversation.chat.turnTail`: that slot renders *above* the Turn's
        // action row, so the amount would sit in its own block. This slot's
        // entries render inside that row, next to "用量 N tok". The owner passes
        // `messageId`, and every slot entry already receives `sessionId`.
        ctx.effect(() => ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'usage-cost-inline',
          order: 20,
        }, ui.Inline)), 'usage-cost: inline money')
      },
    }

  },
})
