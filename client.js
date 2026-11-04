window.__ModuleLoader__.load({
  id: '@local/dsh-openai-api',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * Client half of the `dsh-openai-api` bundle.
     *
     * It owns one settings card: the gateway's bind address, its port, and a
     * start/stop control. The card talks to its own Host half over the Web GUI's
     * route table (`/plugins/dsh-openai-api/settings`), never to the gateway
     * port itself, so it keeps working when the gateway is stopped or bound to
     * another interface.
     */

    const ENDPOINT = '/plugins/dsh-openai-api/settings'
    const ROW_KEY = '@local/dsh-openai-api#dsh-openai-api'

    /** Cards rendered on a bundle page and on its row share one implementation. */
    const CARD_SLOTS = [
      { slot: 'plugins.bundle.config', key: '@local/dsh-openai-api' },
      { slot: 'plugins.row.config', key: ROW_KEY },
    ]

    const CSS = `
.dshoai-card { display: flex; flex-direction: column; gap: 14px; }
.dshoai-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dshoai-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dshoai-dot[data-state="running"] { background: var(--dsw-alias-state-success-primary); }
.dshoai-dot[data-state="stopped"] { background: var(--dsw-alias-state-idle-primary); }
.dshoai-state { font-size: 13px; color: var(--dsw-alias-label-primary); }
.dshoai-url { font-size: 12px; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dshoai-fields { display: flex; gap: 12px; flex-wrap: wrap; }
.dshoai-field { display: flex; flex-direction: column; gap: 6px; min-width: 160px; flex: 1 1 160px; }
.dshoai-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshoai-input {
  box-sizing: border-box; width: 100%; padding: 7px 10px; font-size: 13px;
  font-family: inherit; color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
}
.dshoai-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dshoai-input:disabled { color: var(--dsw-alias-label-secondary); }
.dshoai-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dshoai-btn {
  padding: 6px 14px; font-size: 13px; font-family: inherit; cursor: pointer;
  color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px;
}
.dshoai-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }
.dshoai-btn:disabled { cursor: default; opacity: .55; }
.dshoai-btn[data-variant="primary"] {
  color: var(--dsw-alias-bg-base); background: var(--dsw-alias-brand-primary);
  border-color: var(--dsw-alias-brand-primary);
}
.dshoai-note { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshoai-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); }
`

    /**
     * @param {object} props Slot props.
     * @param {'summary'|'page'} props.view Which part of the card the page asks for.
     */
    function GatewayCard(props) {
      const view = props.view === 'summary' ? 'summary' : 'page'
      const [state, setState] = React.useState(null)
      const [host, setHost] = React.useState('127.0.0.1')
      const [port, setPort] = React.useState('8787')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [note, setNote] = React.useState('')

      const apply = React.useCallback((next) => {
        if (next === null || typeof next !== 'object') return
        setState(next)
        setHost(next.configured?.host ?? next.host ?? '127.0.0.1')
        setPort(String(next.configured?.port ?? next.port ?? 8787))
      }, [])

      React.useEffect(() => {
        let live = true
        fetch(ENDPOINT, { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
          .then((body) => {
            if (live) apply(body)
          })
          .catch((cause) => {
            if (live) setError(`无法读取服务状态：${cause.message}`)
          })
        return () => {
          live = false
        }
      }, [apply])

      const run = React.useCallback(
        async (action, payload) => {
          setBusy(true)
          setError('')
          setNote('')
          try {
            const response = await fetch(ENDPOINT, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action, ...payload }),
            })
            const body = await response.json().catch(() => ({}))
            if (!response.ok) {
              throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`)
            }
            apply(body)
            setNote(
              action === 'stop' ? '服务已停止。' : action === 'start' ? '服务已启动。' : '已保存并应用。',
            )
          } catch (cause) {
            setError(cause.message)
          } finally {
            setBusy(false)
          }
        },
        [apply],
      )

      const running = state?.running === true
      const address = state?.address ?? null

      if (view === 'summary') {
        return h(
          'span',
          { className: 'dshoai-note' },
          running ? `运行中 · ${address ?? `${host}:${port}`}` : '已停止',
        )
      }

      return h(
        'div',
        { className: 'dshoai-card' },
        h(
          'div',
          { className: 'dshoai-head' },
          h('span', {
            className: 'dshoai-dot',
            'data-state': running ? 'running' : 'stopped',
            'aria-hidden': true,
          }),
          h(
            'span',
            { className: 'dshoai-state' },
            state === null ? '正在读取状态…' : running ? '运行中' : '已停止',
          ),
          address !== null ? h('span', { className: 'dshoai-url' }, `${address}/v1`) : null,
        ),
        h(
          'div',
          { className: 'dshoai-fields' },
          h(
            'label',
            { className: 'dshoai-field' },
            h('span', { className: 'dshoai-label' }, '监听地址'),
            h('input', {
              className: 'dshoai-input',
              value: host,
              spellCheck: false,
              autoComplete: 'off',
              placeholder: '127.0.0.1',
              disabled: busy,
              onChange: (event) => setHost(event.target.value),
            }),
          ),
          h(
            'label',
            { className: 'dshoai-field' },
            h('span', { className: 'dshoai-label' }, '端口'),
            h('input', {
              className: 'dshoai-input',
              value: port,
              inputMode: 'numeric',
              spellCheck: false,
              autoComplete: 'off',
              placeholder: '8787',
              disabled: busy,
              onChange: (event) => setPort(event.target.value),
            }),
          ),
        ),
        h(
          'div',
          { className: 'dshoai-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dshoai-btn',
              'data-variant': 'primary',
              disabled: busy || host.trim() === '' || port.trim() === '',
              onClick: () => run('save', { host: host.trim(), port: port.trim() }),
            },
            busy ? '处理中…' : '保存并应用',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshoai-btn',
              disabled: busy || state === null || running,
              onClick: () => run('start'),
            },
            '启动',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshoai-btn',
              disabled: busy || state === null || !running,
              onClick: () => run('stop'),
            },
            '停止',
          ),
        ),
        h(
          'span',
          { className: 'dshoai-note' },
          '保存后立即生效并写入配置，重启 DSH 后保持不变。改成 0.0.0.0 前请设置 API Key。',
        ),
        error !== '' ? h('span', { className: 'dshoai-error' }, error) : null,
        note !== '' && error === '' ? h('span', { className: 'dshoai-note' }, note) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // `styles` is the loader's package-owned stylesheet seat; it is cleaned
        // up with the Client run. Fall back to a head element only if absent.
        ctx.effect(() => {
          if (typeof styles !== 'undefined' && styles !== null) return styles.insert(CSS)
          if (typeof document === 'undefined') return () => {}
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-openai-api')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'dsh-openai-api: card styles')
        for (const { slot, key } of CARD_SLOTS) {
          ctx.slots.inject(slot, () =>
            ctx.slots.register({ name: slot, key, priority: 20 }, GatewayCard),
          )
        }
      },
    }
  },
})
