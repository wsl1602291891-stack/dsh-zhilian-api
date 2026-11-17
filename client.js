/**
 * Client half of `dsh-zhilian-api`: the 智连API settings section.
 *
 * Everything the page shows is read from the plugin's own host API
 * (`/plugins/dsh-zhilian-api/…`). Provider routes are the one exception:
 * they are written through the harness settings Remote into the `llm-pi-ai`
 * namespace, exactly the way the official Models page writes a hand-declared
 * route — so its validation, live reload and conflict handling all apply.
 *
 * @module dsh-zhilian-api/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-zhilian-api',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useSyncExternalStore } = React
    const API = '/plugins/dsh-zhilian-api'
    const NS = 'llm-pi-ai'

    const h = React.createElement

    /** Labels for the refresh-frequency choices, in the order the card shows them. */
    const REFRESH_LABELS = {
      never: '从不',
      hourly: '每小时',
      daily: '每天',
      weekly: '每周'
    }

    /** Auto-close delay for the import success modal. */
    const MODAL_MS = 3000

    // ── styles (official token names, with light-theme fallbacks) ───────────
    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: '12px', maxWidth: '760px', color: 'var(--dsw-alias-label-primary, inherit)' },
      titleRow: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      title: { margin: 0, fontSize: '18px', lineHeight: '28px', fontWeight: 600 },
      pill: (ok) => ({
        display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '1px 9px', borderRadius: '999px',
        fontSize: '12px', lineHeight: '20px',
        color: ok ? 'var(--dsw-alias-state-success-primary, #1a7f37)' : 'var(--dsw-alias-label-tertiary, #666)',
        background: ok ? 'var(--dsw-alias-state-success-surface, rgba(26,127,55,.12))' : 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))'
      }),
      intro: { margin: 0, fontSize: '14px', lineHeight: '22px', color: 'var(--dsw-alias-label-tertiary, #666)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
        borderRadius: '12px', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px'
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      cardTitle: { margin: 0, fontSize: '14px', lineHeight: '22px', fontWeight: 600 },
      muted: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #666)' },
      row: {
        display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
        padding: '10px 0', borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22))'
      },
      rowLast: { borderBottom: 'none', paddingBottom: 0 },
      rowMain: { flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
      rowTitle: { fontSize: '14px', lineHeight: '22px', fontWeight: 500 },
      rowDesc: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #666)' },
      actions: { display: 'inline-flex', alignItems: 'center', gap: '6px', marginLeft: 'auto', flexWrap: 'wrap' },
      button: {
        border: '1px solid var(--dsw-alias-border-l3, rgba(127,127,127,.45))',
        borderRadius: '8px', background: 'transparent', color: 'inherit',
        padding: '5px 12px', fontSize: '13px', lineHeight: '20px', cursor: 'pointer'
      },
      primary: {
        // Fixed brand blue with white text: theme tokens such as
        // `brand-primary` can resolve to white in some themes, which made the
        // label white-on-white. A literal pair stays legible everywhere.
        border: '1px solid #3D57D6',
        borderRadius: '8px',
        background: '#4D6BFE', color: '#ffffff',
        padding: '5px 14px', fontSize: '13px', lineHeight: '20px', fontWeight: 500,
        cursor: 'pointer'
      },
      input: {
        width: '16px', height: '16px', margin: 0, accentColor: 'var(--dsw-alias-brand-primary, #4D6BFE)', cursor: 'pointer'
      },
      chip: {
        display: 'inline-flex', alignItems: 'center', padding: '0 7px', borderRadius: '6px',
        fontSize: '12px', lineHeight: '20px',
        background: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))',
        color: 'var(--dsw-alias-label-secondary, inherit)'
      },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '8px' },
      entry: {
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '1px',
        border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
        borderRadius: '10px', background: 'transparent', color: 'inherit',
        padding: '9px 12px', cursor: 'pointer', textAlign: 'left'
      },
      entryLabel: { fontSize: '13px', lineHeight: '20px', fontWeight: 500 },
      entryNote: { fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #666)' },
      notice: (kind) => ({
        margin: 0, padding: '8px 12px', borderRadius: '8px', fontSize: '13px', lineHeight: '20px',
        color: kind === 'error' ? 'var(--dsw-alias-state-error-primary, #c62828)' : 'var(--dsw-alias-label-secondary, inherit)',
        background: kind === 'error'
          ? 'var(--dsw-alias-state-error-surface, rgba(198,40,40,.10))'
          : 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.10))'
      }),
      kv: { display: 'flex', gap: '18px', flexWrap: 'wrap', fontSize: '13px', lineHeight: '20px' },
      kvItem: { display: 'flex', flexDirection: 'column', gap: '0' },
      kvLabel: { fontSize: '11px', lineHeight: '16px', color: 'var(--dsw-alias-label-tertiary, #666)' },
      footer: { fontSize: '11px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #666)' }
    }

    // ── module-level store (survives remounts during streaming) ─────────────
    const INITIAL = {
      loading: true,
      error: null,
      data: null,
      balance: null,
      selection: [],
      pendingAuth: false,
      autoConnect: false,
      authUrl: null,
      authStartedAt: 0,
      // Success summary shown after an import; closes itself after 3 seconds.
      modal: null,
      busy: null,
      notice: null
    }
    let snapshot = INITIAL
    const listeners = new Set()
    const store = {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      set(patch) {
        snapshot = { ...snapshot, ...(typeof patch === 'function' ? patch(snapshot) : patch) }
        for (const listener of [...listeners]) listener()
      }
    }

    /** One JSON call against the plugin host. */
    async function call(path, init) {
      const response = await fetch(`${API}${path}`, init)
      let value = {}
      try {
        value = await response.json()
      } catch {
        /* status carries the failure */
      }
      return { status: response.status, ...value }
    }

    /** Apply one connect result to the llm-pi-ai settings namespace. */
    async function writeProviders(runtime, result) {
      const ops = []
      for (const id of result.staleRoutes || []) ops.push({ op: 'unset', path: ['providers', id] })
      for (const [id, profile] of Object.entries(result.providers || {})) {
        ops.push({ op: 'set', path: ['providers', id], value: profile })
      }
      if (ops.length === 0) return
      const settings = runtime.ctx.remote?.settings
      if (settings === undefined || typeof settings.mutate !== 'function') {
        throw new Error('DSH 设置服务不可用，无法写入模型路由')
      }
      // The third argument is the revision fence; undefined writes unfenced,
      // which is how the Models page writes too when it holds no revision.
      const response = await settings.mutate(NS, ops, undefined)
      if (response?.ok !== true) {
        throw new Error(response?.error?.message || '写入模型路由被拒绝')
      }
    }

    /** Full state + balance reload. */
    async function reload() {
      try {
        const state = await call('/state')
        if (state.ok !== true) throw new Error(state.error || '读取失败')
        const balance = await call('/balance')
        store.set({
          loading: false,
          error: null,
          data: state,
          balance: balance.ok === true ? balance : null,
          selection: snapshot.selection.length > 0 ? snapshot.selection : state.selection || []
        })
      } catch (error) {
        store.set({ loading: false, error: String(error?.message ?? error) })
      }
    }

    /** Open one of the user's own site pages through the host. */
    async function openPage(runtime, url) {
      const response = await call('/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url })
      })
      if (response.ok !== true) store.set({ notice: { kind: 'error', text: response.error || '打开失败' } })
    }

    /** One-click authorization: create a loopback hand-off, open the site. */
    async function authorize(runtime, autoConnect) {
      store.set({ busy: 'auth', notice: null })
      try {
        const started = await call('/auth/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        })
        if (started.ok !== true) throw new Error(started.error || '无法发起授权')
        store.set({ pendingAuth: true, autoConnect, authUrl: started.url, authStartedAt: Date.now() })
        const opened = await call('/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: started.url })
        })
        if (opened.ok !== true) throw new Error(opened.error || '无法打开授权页面')
        store.set({ notice: { kind: 'info', text: '已在浏览器打开授权页；登录后将自动返回并接入。' } })
      } catch (error) {
        store.set({ pendingAuth: false, notice: { kind: 'error', text: String(error?.message ?? error) } })
      } finally {
        store.set({ busy: null })
      }
    }

    /** Mint keys and declare the protocol routes for the selection. */
    async function connect(runtime, groups, silent = false) {
      if (!Array.isArray(groups) || groups.length === 0) {
        store.set({ notice: { kind: 'error', text: '至少选择一个分组' } })
        return
      }
      store.set({ busy: 'connect', notice: null })
      try {
        const result = await call('/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ groups })
        })
        if (result.status === 401 || result.needAuth === true) {
          store.set({ notice: { kind: 'error', text: '授权已过期，请先点「一键授权」' } })
          return
        }
        if (result.ok !== true) {
          const reasons = (result.skipped || [])
            .map(item => `${item.group}：${item.reason}`)
            .join('；')
          throw new Error(reasons ? `${result.error || '接入失败'}（${reasons}）` : (result.error || '接入失败'))
        }
        await writeProviders(runtime, result)
        const lines = (result.groups || []).map(item => {
          const verb =
            item.action === 'created' ? '新建'
              : item.action === 'updated' ? '更新'
                : item.action === 'enabled' ? '启用'
                  : '复用'
          return `${item.group}：${verb} Key，${item.models} 个模型`
        })
        const skipped = (result.skipped || []).map(item => `${item.group}：${item.reason}`)
        store.set({
          notice: {
            kind: 'info',
            text: [`已写入模型路由。`, ...lines, ...skipped].join(' ')
          },
          ...(silent ? {} : {
            modal: {
              title: '导入成功',
              groups: (result.groups || []).map(item => item.group),
              routes: Object.keys(result.providers || {}).length,
              removed: result.removed || []
            }
          }),
          data: result.state || snapshot.data
        })
        await reload()
      } catch (error) {
        store.set({ notice: { kind: 'error', text: String(error?.message ?? error) } })
      } finally {
        store.set({ busy: null })
      }
    }

    /** Poll while the browser flow is in flight; auto-connect when it lands. */
    function useAuthPolling(runtime) {
      const pendingAuth = useSyncExternalStore(store.subscribe, () => snapshot.pendingAuth)
      const autoConnect = useSyncExternalStore(store.subscribe, () => snapshot.autoConnect)
      const selection = useSyncExternalStore(store.subscribe, () => snapshot.selection)
      useEffect(() => {
        if (!pendingAuth) return undefined
        let cancelled = false
        const timer = setInterval(async () => {
          if (Date.now() - snapshot.authStartedAt > 10 * 60 * 1000) {
            store.set({
              pendingAuth: false,
              autoConnect: false,
              notice: { kind: 'error', text: '授权等待已超时，请重新点「一键授权」。' }
            })
            return
          }
          try {
            const status = await call('/auth/status')
            if (cancelled || status.ok !== true || status.authorized !== true) return
            store.set({ pendingAuth: false, autoConnect: false })
            await reload()
            if (autoConnect) {
              const groups = snapshot.selection.length > 0 ? snapshot.selection : selection
              await connect(runtime, groups)
            }
          } catch {
            /* keep polling */
          }
        }, 2000)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [pendingAuth, autoConnect, selection, runtime])
    }

    /** Format a NewAPI quota as USD (the site's 500k quota = $1 unit). */
    function money(quota, meta) {
      if (typeof quota !== 'number' || !Number.isFinite(quota)) return '—'
      const perUnit = Number(meta?.quotaPerUnit) || 500000
      return `$${(quota / perUnit).toFixed(2)}`
    }

    /** One switch-like checkbox row. */
    function GroupRow(props) {
      const { group, checked, onToggle, isLast } = props
      const disabled = group.counts.total === 0
      return h(
        'div',
        { style: isLast ? { ...S.row, ...S.rowLast } : S.row },
        h('input', {
          type: 'checkbox',
          style: S.input,
          checked,
          disabled,
          onChange: () => onToggle(group.name),
          'aria-label': `接入分组 ${group.name}`
        }),
        h(
          'div',
          { style: S.rowMain },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('span', { style: S.rowTitle }, group.name),
            typeof group.ratio === 'number' ? h('span', { style: S.chip }, `×${group.ratio}`) : null,
            group.connected ? h('span', { style: S.pill(true) }, '已接入') : null
          ),
          h(
            'div',
            { style: S.rowDesc },
            disabled
              ? '该分组没有可路由的文本模型'
              : `GPT ${group.counts.gpt} · Claude ${group.counts.claude} · 通用 ${group.counts.chat}`
          )
        )
      )
    }

    /** The settings section itself. */
    function Section(props) {
      const runtime = props.runtime
      const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
      useAuthPolling(runtime)

      // The success summary closes itself after MODAL_MS. A new modal object
      // restarts the countdown; unmounting clears it.
      useEffect(() => {
        if (state.modal === null) return undefined
        const timer = setTimeout(() => store.set({ modal: null }), MODAL_MS)
        return () => clearTimeout(timer)
      }, [state.modal])

      // Scheduled model refresh: while the page is open and a session exists,
      // re-run the connect with the current selection once the chosen interval
      // has elapsed since the last sync. Silent on success.
      useEffect(() => {
        const intervalMs = {
          hourly: 60 * 60 * 1000,
          daily: 24 * 60 * 60 * 1000,
          weekly: 7 * 24 * 60 * 60 * 1000
        }[state.data?.refreshInterval]
        if (intervalMs === undefined || state.data?.authorized !== true) return undefined
        const timer = setInterval(async () => {
          const last = Number(state.data?.lastSyncAt || 0)
          if (Date.now() - last < intervalMs) return
          if (snapshot.busy !== null) return
          const groups = snapshot.selection.length > 0 ? snapshot.selection : (state.data?.selection || [])
          if (groups.length === 0) return
          await connect(runtime, groups, true)
        }, 60 * 1000)
        return () => clearInterval(timer)
      }, [state.data?.refreshInterval, state.data?.authorized, state.data?.lastSyncAt, runtime])

      useEffect(() => {
        void reload()
      }, [])

      const data = state.data
      const selection = state.selection
      const setSelection = useCallback((updater) => {
        store.set(current => ({ selection: updater(current.selection) }))
      }, [])
      const toggle = useCallback((name) => {
        setSelection(current =>
          current.includes(name) ? current.filter(item => item !== name) : [...current, name]
        )
      }, [setSelection])

      if (state.loading && data === null) {
        return h('div', { style: S.page }, h('p', { style: S.intro }, '正在读取新API 账户与模型目录…'))
      }

      const groups = Array.isArray(data?.groups) ? data.groups : []
      const connected = groups.filter(group => group.connected)
      const balanceByGroup = new Map(
        (state.balance?.keys || []).map(item => [item.group, item])
      )
      const user = data?.user || null
      const account = state.balance?.account || null
      // Fall back to the last account snapshot so balance stays visible after
      // a restart, when the session token is gone but the keys still work.
      const quotaValue = account?.quota ?? user?.quota
      const usedValue = account?.usedQuota ?? user?.usedQuota
      const requestValue = account?.requestCount ?? user?.requestCount

      return h(
        'div',
        { style: S.page },
        h(
          'div',
          { style: S.titleRow },
          h('h2', { style: S.title }, '智连API'),
          h('span', { style: S.pill(data?.authorized === true) }, data?.authorized ? '账号已连接' : '未授权'),
          h(
            'span',
            { style: { marginLeft: 'auto', display: 'inline-flex', gap: '6px' } },
            h(
              'button',
              {
                type: 'button',
                style: S.button,
                disabled: state.busy !== null,
                onClick: async () => {
                  await call('/refresh', { method: 'POST' })
                  await reload()
                }
              },
              '刷新目录'
            )
          )
        ),
        h('p', { style: S.intro }, '一键授权本站账号，按分组复用/创建专用 Key；GPT 走 Responses、Claude 走 Messages、其他走 Chat，全部自动判断。'),

        state.modal
          ? h(
              'div',
              {
                role: 'dialog',
                'aria-modal': 'true',
                style: {
                  position: 'fixed', inset: 0, zIndex: 1200, display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(0,0,0,.35)'
                },
                onClick: () => store.set({ modal: null })
              },
              h(
                'div',
                {
                  style: {
                    width: 'min(420px, calc(100vw - 40px))', padding: '20px 22px',
                    borderRadius: '14px', background: 'var(--dsw-alias-bg-layer-1, #26262a)',
                    color: 'var(--dsw-alias-label-primary, #eaeaea)',
                    border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))',
                    display: 'flex', flexDirection: 'column', gap: '12px'
                  },
                  onClick: event => event.stopPropagation()
                },
                h('div', { style: { fontSize: '16px', fontWeight: 600 } }, '✅ 导入成功'),
                h(
                  'div',
                  { style: { fontSize: '13px', lineHeight: '20px' } },
                  `已导入 ${state.modal.groups.length} 个分组，写入 ${state.modal.routes} 条模型路由。`
                ),
                h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                  state.modal.groups.map(group =>
                    h('div', { key: group, style: S.chip }, `智连API · ${group}`)
                  )
                ),
                state.modal.removed.length > 0
                  ? h('div', { style: S.muted }, `已移除：${state.modal.removed.join('、')}`)
                  : null,
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
                  h('span', { style: S.muted }, '3 秒后自动关闭'),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: S.primary,
                      onClick: () => store.set({ modal: null })
                    },
                    '我知道了'
                  )
                )
              )
            )
          : null,

        state.notice
          ? h('p', { style: S.notice(state.notice.kind) }, state.notice.text)
          : null,
        state.error ? h('p', { style: S.notice('error') }, state.error) : null,

        // ── account / authorization ───────────────────────────────────────
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.cardHead },
            h('h3', { style: S.cardTitle }, '账号与授权'),
            data?.site
              ? h('span', { style: S.chip }, data.site.replace(/^https?:\/\//, ''))
              : null,
            h(
              'div',
              { style: S.actions },
              h(
                'button',
                {
                  type: 'button',
                  style: S.primary,
                  disabled: state.busy !== null,
                  onClick: () => authorize(runtime, true)
                },
                state.pendingAuth ? '等待浏览器授权…' : (user ? '重新授权' : '一键授权')
              ),
              state.pendingAuth
                ? h(
                    'button',
                    {
                      type: 'button',
                      style: S.button,
                      onClick: () => store.set({ pendingAuth: false, autoConnect: false, authUrl: null })
                    },
                    '取消等待'
                  )
                : null,
              user
                ? h(
                    'button',
                    {
                      type: 'button',
                      style: S.button,
                      disabled: state.busy !== null,
                      onClick: async () => {
                        await call('/auth/logout', { method: 'POST' })
                        await reload()
                        store.set({ notice: { kind: 'info', text: '已退出账号；已接入的 Key 与模型路由保留可用。' } })
                      }
                    },
                    '退出账号'
                  )
                : null,
              h(
                'button',
                {
                  type: 'button',
                  style: S.button,
                  onClick: () => openPage(runtime, `${data?.site || 'https://api.888425.xyz'}/wallet`)
                },
                '去充值'
              )
            )
          ),
          user
            ? h(
                'div',
                { style: S.kv },
                h('div', { style: S.kvItem }, h('span', { style: S.kvLabel }, '账号'), h('span', null, user.displayName || user.username || `#${user.id}`)),
                typeof quotaValue === 'number'
                  ? h('div', { style: S.kvItem }, h('span', { style: S.kvLabel }, '账户余额'), h('span', null, money(quotaValue, data?.money)))
                  : null,
                typeof usedValue === 'number'
                  ? h('div', { style: S.kvItem }, h('span', { style: S.kvLabel }, '已用'), h('span', null, money(usedValue, data?.money)))
                  : null,
                typeof requestValue === 'number'
                  ? h('div', { style: S.kvItem }, h('span', { style: S.kvLabel }, '请求数'), h('span', null, String(requestValue)))
                  : null,
                account?.group
                  ? h('div', { style: S.kvItem }, h('span', { style: S.kvLabel }, '默认分组'), h('span', null, account.group))
                  : null
              )
            : h('p', { style: S.muted }, state.pendingAuth
                ? '已打开浏览器授权页。若未自动打开，请用下面的链接手动打开。'
                : '点击「一键授权」会在浏览器打开本站授权页；登录后自动回到桌面端完成授权，不需要复制粘贴 Key。'),
          state.pendingAuth && state.authUrl
            ? h(
                'a',
                {
                  href: state.authUrl,
                  target: '_blank',
                  rel: 'noreferrer',
                  style: { fontSize: '12px', color: 'var(--dsw-alias-link-primary, #4D6BFE)', wordBreak: 'break-all' }
                },
                state.authUrl
              )
            : null
        ),

        // ── groups ─────────────────────────────────────────────────────────
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.cardHead },
            h('h3', { style: S.cardTitle }, '分组模型'),
            h('span', { style: S.muted }, groups.length > 0 ? `${groups.length} 个可用分组` : '暂无分组'),
            h(
              'div',
              { style: S.actions },
              h(
                'button',
                {
                  type: 'button',
                  style: S.primary,
                  disabled: state.busy !== null || selection.length === 0,
                  onClick: async () => {
                    if (!data?.authorized) {
                      await authorize(runtime, true)
                      return
                    }
                    await connect(runtime, selection)
                  }
                },
                state.busy === 'connect' ? '正在接入…' : '接入所选分组'
              )
            )
          ),
          h('p', { style: S.muted }, '每个分组一把专用 Key（同名复用，模型范围变更原地更新）；选中即出现在模型选择器的提供方列表里。'),
          groups.length === 0
            ? h('p', { style: S.muted }, '没有读取到分组，请先刷新目录或确认账号分组权限。')
            : h(
                'div',
                null,
                groups.map((group, index) =>
                  h(GroupRow, {
                    key: group.name,
                    group,
                    checked: selection.includes(group.name),
                    onToggle: toggle,
                    isLast: index === groups.length - 1
                  })
                )
              )
        ),

        // ── protocol routing ───────────────────────────────────────────────
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.cardHead },
            h('h3', { style: S.cardTitle }, '协议路由'),
            h('span', { style: S.chip }, '自动按模型族')
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.rowMain },
              h('div', { style: S.rowTitle }, 'GPT / o 系列 / Codex'),
              h('div', { style: S.rowDesc }, '模型名以 gpt、chatgpt、codex、o1–o9 开头')
            ),
            h('span', { style: S.chip }, 'POST /v1/responses')
          ),
          h(
            'div',
            { style: S.row },
            h('div', { style: S.rowMain },
              h('div', { style: S.rowTitle }, 'Claude / Anthropic'),
              h('div', { style: S.rowDesc }, '模型名以 claude、anthropic 开头')
            ),
            h('span', { style: S.chip }, 'POST /v1/messages')
          ),
          h(
            'div',
            { style: { ...S.row, ...S.rowLast } },
            h('div', { style: S.rowMain },
              h('div', { style: S.rowTitle }, '其他全部模型'),
              h('div', { style: S.rowDesc }, 'deepseek、glm、qwen、kimi、gemini 等')
            ),
            h('span', { style: S.chip }, 'POST /v1/chat/completions')
          ),
          h('p', { style: S.muted }, '本站对每个模型都声明了三种端点，因此按模型名分族才是可靠口径；无需手动切换协议。')
        ),

        // ── connected usage ────────────────────────────────────────────────
        connected.length > 0
          ? h(
              'div',
              { style: S.card },
              h('div', { style: S.cardHead }, h('h3', { style: S.cardTitle }, '已接入 Key 的用量')),
              connected.map((group, index) => {
                const usage = balanceByGroup.get(group.name)
                return h(
                  'div',
                  { key: group.name, style: index === connected.length - 1 ? { ...S.row, ...S.rowLast } : S.row },
                  h(
                    'div',
                    { style: S.rowMain },
                    h('div', { style: S.rowTitle }, group.name),
                    h(
                      'div',
                      { style: S.rowDesc },
                      usage === undefined
                        ? 'Key 状态读取中…'
                        : usage.missing
                          ? '本地凭据缺失，请重新接入'
                          : usage.error
                            ? `读取失败：${usage.error}`
                            : `可用 ${money(usage.available, data?.money)} · 已用 ${money(usage.used, data?.money)}${usage.unlimited ? ' · 无限额度' : ''}`
                    )
                  ),
                  h('span', { style: S.chip }, group.keyRef || '—')
                )
              })
            )
          : null,

        // ── model refresh frequency ────────────────────────────────────────
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.cardHead },
            h('h3', { style: S.cardTitle }, '模型刷新频率'),
            h('span', { style: S.chip }, data?.refreshInterval === 'never' || !data?.refreshInterval ? '从不' : REFRESH_LABELS[data.refreshInterval])
          ),
          h(
            'div',
            { style: S.grid },
            ['never', 'hourly', 'daily', 'weekly'].map(value =>
              h(
                'button',
                {
                  key: value,
                  type: 'button',
                  style: data?.refreshInterval === value
                    ? { ...S.primary, textAlign: 'center' }
                    : { ...S.button, textAlign: 'center' },
                  onClick: async () => {
                    const response = await call('/refresh-interval', {
                      method: 'POST',
                      headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ interval: value })
                    })
                    if (response.ok === true) store.set({ data: response.state })
                  }
                },
                REFRESH_LABELS[value]
              )
            )
          ),
          h(
            'p',
            { style: S.muted },
            '建议设为每天或每周：本站模型上新与下架频繁，定期刷新能让模型列表保持最新，又不会频繁打扰站点。选择「从不」则只在你手动点「接入所选分组」时更新。'
          )
        ),

        // ── site entries ───────────────────────────────────────────────────
        h(
          'div',
          { style: S.card },
          h('div', { style: S.cardHead }, h('h3', { style: S.cardTitle }, '本站功能入口')),
          h(
            'div',
            { style: S.grid },
            (data?.entries || []).map(entry =>
              h(
                'button',
                {
                  key: entry.path,
                  type: 'button',
                  style: S.entry,
                  onClick: () => openPage(runtime, `${data.site}${entry.path}`)
                },
                h('span', { style: S.entryLabel }, entry.label),
                h('span', { style: S.entryNote }, entry.note)
              )
            )
          ),
          h(
            'p',
            { style: S.footer },
            'Key 名称固定为「DSH 桌面 / DeepSeek Harness」，每个分组一把；同名同组复用，模型范围变化时原地更新，不会越接越多。'
          )
        )
      )
    }

    /** Small nav glyph for the settings sidebar. */
    function NavIcon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M9 7V5a3 3 0 0 1 6 0v2M7 7h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Zm2 5h6',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round'
        })
      )
    }

    return {
      inject: ['slots', 'remote', 'remote.settings'],
      apply(ctx) {
        const runtime = { ctx }
        ctx.effect(
          () =>
            ctx.slots.inject('settings.section', () =>
              ctx.slots.register(
                {
                  name: 'settings.section',
                  id: 'newapi',
                  order: 36,
                  label: () => '智连API'
                },
                () => h(Section, { runtime })
              )
            ),
          'dsh-zhilian-api: settings section'
        )
        try {
          ctx.effect(
            () =>
              ctx.slots.inject('settings.section.icon', () =>
                ctx.slots.register({ name: 'settings.section.icon', id: 'newapi' }, NavIcon)
              ),
            'dsh-zhilian-api: settings nav icon'
          )
        } catch {
          /* older shells draw their own gear; the page still registers */
        }
      }
    }
  }
})
