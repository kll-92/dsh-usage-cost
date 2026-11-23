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
    if (!cost || cost.state === 'pending') return '¥…'
    if (cost.state === 'no-data') return '无数据'
    if (cost.state === 'unpriced') return '未定价'
    return '≈' + formatMoney(cost.amount) + ' · ' + formatCompactTokens(cost.tokens)
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
