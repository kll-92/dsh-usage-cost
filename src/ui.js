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
