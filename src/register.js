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

        // Session display titles for the per-session view; optional like the others.
        ctx.inject(['sessions'], (scoped) => {
          ledger.setTitleResolver(function (sessionId) {
            try {
              var snapshot = scoped.sessions.list.getSnapshot()
              var summary = snapshot && snapshot.byId ? snapshot.byId[sessionId] : undefined
              return summary && summary.displayTitle
            } catch (error) {
              return undefined
            }
          })
        })

        ledger.setDiag({ build: 'week-by-session' })

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
