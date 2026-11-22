/**
 * DeepSeek share-link import: browser half.
 *
 * Adds one action to the sidebar's footer action row (above the account row,
 * possibly beside other plugins' actions). The panel it opens previews a
 * share, then imports it into the workspace the user picks; both steps call
 * the Host routes this bundle's Host half registers. The bundle is plain ESM
 * with no build step and no runtime dependency besides React, which the page
 * already provides.
 */

window.__ModuleLoader__.load({
  id: 'dsh-share-link-import',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** Host route prefix owned by this plugin. */
    const API = '/__share-link-import'

    /**
     * Styles of the panel, with its own light and dark palettes.
     *
     * The dialog carries explicit colors instead of inheriting theme tokens:
     * the shipped overlay tokens are translucent, so inside the sidebar the
     * panel came out grey-on-grey in dark mode and washed out in light mode.
     * `data-theme` is decided at runtime from the page, so the panel also
     * follows a theme the user picked in DSH rather than the OS default.
     */
    const CSS = `
.share-import-action {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px;
  background: transparent; color: inherit; cursor: pointer;
}
.share-import-action:hover { background: rgba(128, 128, 128, .18); }
.share-import-action:focus-visible { outline: 2px solid #4f6ef7; outline-offset: 2px; }
.share-import-backdrop {
  position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center;
  background: rgba(8, 10, 14, .55); padding: 24px;
}
.share-import-panel {
  --si-panel: #ffffff;
  --si-text: #17181c;
  --si-muted: #5b6472;
  --si-border: #dfe3e9;
  --si-input: #f8f9fb;
  --si-input-border: #d3d8df;
  --si-placeholder: #687080;
  --si-btn: #ffffff;
  --si-btn-border: #d3d8df;
  --si-btn-text: #22252b;
  --si-btn-hover: #f1f3f7;
  --si-primary: #3157e8;
  --si-primary-text: #ffffff;
  --si-primary-hover: #2a4cd0;
  --si-off-bg: #eef0f4;
  --si-off-text: #5f6874;
  --si-off-border: #e3e6eb;
  --si-shadow: rgba(15, 23, 42, .22);
  --si-info-bg: #f1f3f8;
  --si-info-text: #2a2f37;
  --si-error-bg: #fdecec;
  --si-error-text: #a4231b;
  --si-ok-bg: #e8f6ee;
  --si-ok-text: #136b3a;
  --si-warn-bg: #fff4e0;
  --si-warn-text: #7a5300;
  color-scheme: light;
  width: min(560px, 100%); max-height: 86vh; overflow: auto; box-sizing: border-box;
  background: var(--si-panel); color: var(--si-text);
  border: 1px solid var(--si-border); border-radius: 14px;
  box-shadow: 0 18px 48px var(--si-shadow); padding: 20px 22px 18px;
  font: inherit; font-size: 13px; line-height: 1.55;
}
.share-import-panel[data-theme="dark"] {
  --si-panel: #24262c;
  --si-text: #f1f2f4;
  --si-muted: #b6bbc4;
  --si-border: #3b3f47;
  --si-input: #17181c;
  --si-input-border: #434852;
  --si-placeholder: #8b929d;
  --si-btn: #2d3037;
  --si-btn-border: #474c56;
  --si-btn-text: #eceef2;
  --si-btn-hover: #363a42;
  --si-primary: #4361e8;
  --si-primary-text: #ffffff;
  --si-primary-hover: #5a76ff;
  --si-off-bg: #2a2d33;
  --si-off-text: #989fab;
  --si-off-border: #363a41;
  --si-shadow: rgba(0, 0, 0, .62);
  --si-info-bg: #1c1e23;
  --si-info-text: #dfe3ea;
  --si-error-bg: #3a2325;
  --si-error-text: #ffb4ac;
  --si-ok-bg: #17301f;
  --si-ok-text: #8fe3ac;
  --si-warn-bg: #332a17;
  --si-warn-text: #f2c878;
  color-scheme: dark;
}
.share-import-panel h2 { margin: 0 0 4px; font-size: 15px; font-weight: 600; color: var(--si-text); }
.share-import-hint { margin: 0 0 14px; color: var(--si-muted); font-size: 12px; }
.share-import-label { display: block; margin: 0 0 6px; font-weight: 600; font-size: 12px; color: var(--si-text); }
.share-import-input, .share-import-select {
  width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 9px;
  border: 1px solid var(--si-input-border);
  background: var(--si-input); color: var(--si-text); font: inherit;
}
.share-import-input::placeholder { color: var(--si-placeholder); opacity: 1; }
.share-import-input:focus-visible, .share-import-select:focus-visible {
  outline: 2px solid var(--si-primary); outline-offset: 1px; border-color: var(--si-primary);
}
.share-import-input { min-height: 64px; resize: vertical; }
.share-import-select option { background: var(--si-panel); color: var(--si-text); }
.share-import-row { display: flex; gap: 8px; margin-top: 14px; }
.share-import-spacer { flex: 1; }
.share-import-button {
  padding: 7px 14px; border-radius: 9px; border: 1px solid var(--si-btn-border);
  background: var(--si-btn); color: var(--si-btn-text); font: inherit; cursor: pointer;
}
.share-import-button:hover:not(:disabled) { background: var(--si-btn-hover); }
.share-import-button:focus-visible { outline: 2px solid var(--si-primary); outline-offset: 2px; }
.share-import-button.primary {
  border-color: transparent; background: var(--si-primary); color: var(--si-primary-text);
}
.share-import-button.primary:hover:not(:disabled) { background: var(--si-primary-hover); }
.share-import-button:disabled, .share-import-button.primary:disabled {
  border-color: var(--si-off-border); background: var(--si-off-bg); color: var(--si-off-text);
  cursor: default;
}
.share-import-note { margin: 12px 0 0; font-size: 12px; color: var(--si-muted); }
.share-import-status { margin-top: 14px; padding: 10px 12px; border-radius: 9px; font-size: 12px; white-space: pre-wrap; }
.share-import-status.info { background: var(--si-info-bg); color: var(--si-info-text); }
.share-import-status.error { background: var(--si-error-bg); color: var(--si-error-text); }
.share-import-status.success { background: var(--si-ok-bg); color: var(--si-ok-text); }
.share-import-status.warn { background: var(--si-warn-bg); color: var(--si-warn-text); }
.share-import-status strong { color: inherit; }
.share-import-meta { margin: 6px 0 0; padding-left: 18px; }
.share-import-meta li { margin: 2px 0; }
`

    /**
     * Call one Host route.
     * @param {string} path - route suffix, such as `/preview`.
     * @param {{method?: string, body?: object, signal?: AbortSignal}} [options] - request options.
     * @returns {Promise<object>} the decoded success envelope.
     */
    async function request(path, options = {}) {
      let response
      try {
        response = await fetch(`${API}${path}`, {
          method: options.method ?? 'GET',
          headers: options.body === undefined ? undefined : { 'Content-Type': 'application/json' },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: options.signal,
        })
      } catch {
        throw failure('无法连接本地导入服务，请确认插件已启用并刷新页面。')
      }
      let payload
      try {
        payload = await response.json()
      } catch {
        throw failure(`导入服务返回了非 JSON 响应（HTTP ${response.status}）。`)
      }
      if (payload !== null && typeof payload === 'object' && payload.ok === false) {
        throw failure(payload.message, payload.code, payload.details)
      }
      if (!response.ok) {
        throw failure(payload?.message ?? `导入服务返回 HTTP ${response.status}。`, payload?.code)
      }
      return payload
    }

    /**
     * Build the failure object the panel renders.
     * @param {string} message - Chinese explanation.
     * @param {string} [code] - machine code.
     * @param {object} [details] - extra facts, such as an already stored session id.
     * @returns {{message: string, code: string, details: object}} the failure.
     */
    function failure(message, code = 'INTERNAL', details = {}) {
      return { message: message || '导入失败。', code, details: details ?? {} }
    }

    /**
     * Parse one CSS color into its channels.
     * @param {string} value - a computed style value, `rgb()`/`rgba()` or hex.
     * @returns {{r: number, g: number, b: number, a: number}|null} the channels, or null when unreadable.
     */
    function parseColor(value) {
      if (typeof value !== 'string') return null
      const text = value.trim()
      const rgb = /^rgba?\(([^)]+)\)$/iu.exec(text)
      if (rgb !== null) {
        const parts = rgb[1].split(/[,\s/]+/u).filter(Boolean).map(Number)
        if (parts.length >= 3 && parts.slice(0, 3).every(part => Number.isFinite(part))) {
          return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 }
        }
        return null
      }
      const hex = /^#([0-9a-f]{3,8})$/iu.exec(text)
      if (hex === null) return null
      const raw = hex[1].length <= 4 ? hex[1].split('').map(char => char + char).join('') : hex[1]
      if (raw.length < 6) return null
      return {
        r: Number.parseInt(raw.slice(0, 2), 16),
        g: Number.parseInt(raw.slice(2, 4), 16),
        b: Number.parseInt(raw.slice(4, 6), 16),
        a: 1,
      }
    }

    /**
     * Relative brightness of one color, on a 0–1 scale.
     * @param {{r: number, g: number, b: number}} color - the channels.
     * @returns {number} the luminance.
     */
    function luminance(color) {
      return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255
    }

    /**
     * Read the theme the page is actually rendered in.
     *
     * DSH lets the user force a theme independently of the operating system, so
     * `prefers-color-scheme` is only the last resort: explicit markers win, then
     * the page's own text color, which is light on a dark theme.
     *
     * @returns {'light'|'dark'} the theme of the surrounding UI.
     */
    function readTheme() {
      for (const element of [document.documentElement, document.body]) {
        if (element === null || element === undefined) continue
        const marker = element.getAttribute('data-theme') ?? element.getAttribute('data-color-scheme')
        if (marker === 'dark' || marker === 'light') return marker
      }
      for (const element of [document.documentElement, document.body]) {
        if (element === null || element === undefined) continue
        if (element.classList.contains('dark') || element.classList.contains('theme-dark')) return 'dark'
      }
      // The theme tokens are the most trustworthy reading: the base background
      // is opaque, and a dark theme always paints it dark.
      const rootStyle = window.getComputedStyle(document.documentElement)
      const base = parseColor(rootStyle.getPropertyValue('--dsw-alias-bg-base'))
      if (base !== null && base.a > 0.5) return luminance(base) < 0.45 ? 'dark' : 'light'
      const label = parseColor(rootStyle.getPropertyValue('--dsw-alias-label-primary'))
      if (label !== null && label.a > 0.5) return luminance(label) > 0.55 ? 'dark' : 'light'
      const probe = document.body ?? document.documentElement
      if (probe !== null && probe !== undefined) {
        const style = window.getComputedStyle(probe)
        const background = parseColor(style.backgroundColor)
        if (background !== null && background.a > 0.5) return luminance(background) < 0.45 ? 'dark' : 'light'
        const text = parseColor(style.color)
        if (text !== null && text.a > 0.5) return luminance(text) > 0.55 ? 'dark' : 'light'
      }
      return window.matchMedia?.('(prefers-color-scheme: dark)').matches === true ? 'dark' : 'light'
    }

    /**
     * Follow the page theme.
     *
     * The DSH theme service is the authority; the DOM reading and the media
     * query only cover the moment before that service is reachable.
     *
     * @param {{read: () => ('light'|'dark'|null), subscribe: (listener: () => void) => (() => void)|undefined}} [environment] - theme service bridge.
     * @returns {'light'|'dark'} the live theme.
     */
    function useTheme(environment) {
      const read = () => environment?.read?.() ?? readTheme()
      const [theme, setTheme] = useState(read)
      useEffect(() => {
        const update = () => setTheme(read())
        update()
        const unsubscribe = environment?.subscribe?.(update)
        const watched = { attributes: true, attributeFilter: ['class', 'data-theme', 'data-color-scheme', 'style'] }
        const observer = new MutationObserver(update)
        observer.observe(document.documentElement, watched)
        if (document.body !== null) observer.observe(document.body, watched)
        const media = window.matchMedia?.('(prefers-color-scheme: dark)')
        media?.addEventListener?.('change', update)
        return () => {
          unsubscribe?.()
          observer.disconnect()
          media?.removeEventListener?.('change', update)
        }
      }, [environment])
      return theme
    }

    /**
     * The sidebar-foot action that opens the panel.
     *
     * The button inherits the sidebar's own text color, so it matches whatever
     * theme the shell renders, and it carries no colors of its own.
     * @param {{themeEnvironment?: object}} props - theme bridge passed by the Host half.
     */
    function FooterAction(props) {
      const [open, setOpen] = useState(false)
      const close = useCallback(() => setOpen(false), [])

      return h(
        React.Fragment,
        null,
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: 'share-import-action',
          title: '分享导入',
          'aria-label': '分享导入',
          onClick: () => setOpen(true),
        }, h('svg', {
          viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M12 3v12' }),
        h('path', { d: 'm7.5 10.5 4.5 4.5 4.5-4.5' }),
        h('path', { d: 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2' }))),
        open ? h(Panel, { onClose: close, themeEnvironment: props.themeEnvironment }) : null,
      )
    }

    /**
     * The import dialog.
     * @param {{onClose: () => void, themeEnvironment?: object}} props - close callback and theme bridge.
     */
    function Panel(props) {
      const [link, setLink] = useState('')
      const [workspaces, setWorkspaces] = useState(null)
      const [workspaceId, setWorkspaceId] = useState('')
      const [busy, setBusy] = useState('')
      const [preview, setPreview] = useState(null)
      const [result, setResult] = useState(null)
      const [error, setError] = useState(null)
      const inputRef = useRef(null)
      const onClose = props.onClose
      const theme = useTheme(props.themeEnvironment)

      useEffect(() => {
        inputRef.current?.focus()
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [onClose])

      useEffect(() => {
        let cancelled = false
        request('/workspaces')
          .then((payload) => {
            if (cancelled) return
            setWorkspaces(payload.workspaces)
            setWorkspaceId(current => current || payload.workspaces[0]?.id || '')
          })
          .catch((failure) => { if (!cancelled) setError(failure) })
        return () => { cancelled = true }
      }, [])

      const reset = () => {
        setPreview(null)
        setResult(null)
        setError(null)
      }

      const runPreview = async () => {
        setBusy('preview')
        reset()
        try {
          setPreview(await request('/preview', { method: 'POST', body: { link } }))
        } catch (failure) {
          setError(failure)
        } finally {
          setBusy('')
        }
      }

      const runImport = async (force) => {
        setBusy('import')
        setError(null)
        try {
          const payload = await request('/import', {
            method: 'POST',
            body: { link, workspaceId, force },
          })
          setResult(payload)
          setPreview(null)
        } catch (failure) {
          setError(failure)
        } finally {
          setBusy('')
        }
      }

      const alreadyImported = preview?.alreadyImported
      const canImport = workspaceId !== '' && link.trim() !== '' && busy === '' && workspaces !== null

      return h('div', {
        className: 'share-import-backdrop',
        onClick: (event) => { if (event.target === event.currentTarget) onClose() },
      }, h('div', {
        className: 'share-import-panel',
        'data-theme': theme,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '分享导入',
      },
      h('h2', null, '分享导入'),
      h('p', { className: 'share-import-hint' },
        '把 DeepSeek 公开分享链接中的问答导入为一个本地会话：只写入历史，不触发任何模型生成。'),
      h('label', { className: 'share-import-label', htmlFor: 'share-import-link' }, '分享链接'),
      h('textarea', {
        id: 'share-import-link',
        ref: inputRef,
        className: 'share-import-input',
        placeholder: 'https://chat.deepseek.com/share/xxxxxxxx',
        value: link,
        spellCheck: false,
        onChange: (event) => { setLink(event.target.value); reset() },
      }),
      h('label', {
        className: 'share-import-label',
        htmlFor: 'share-import-workspace',
        style: { marginTop: 12 },
      }, '目标工作区'),
      h('select', {
        id: 'share-import-workspace',
        className: 'share-import-select',
        value: workspaceId,
        disabled: workspaces === null || workspaces.length === 0,
        onChange: (event) => { setWorkspaceId(event.target.value); reset() },
      },
      workspaces === null
        ? h('option', { value: '' }, '正在加载工作区…')
        : workspaces.length === 0
          ? h('option', { value: '' }, '没有可用的工作区')
          : workspaces.map(workspace => h('option', {
            key: workspace.id,
            value: workspace.id,
          }, `${workspace.title} — ${workspace.path}`))),

      preview ? h('div', { className: 'share-import-status info' },
        h('strong', null, preview.title || '(无标题)'),
        h('ul', { className: 'share-import-meta' },
          h('li', null, `问答轮次：${preview.rounds}`),
          h('li', null, `分享 ID：${preview.shareId}`),
          preview.droppedUnanswered > 0
            ? h('li', null, `已忽略 ${preview.droppedUnanswered} 个没有回答的提问`)
            : null)) : null,

      alreadyImported ? h('div', { className: 'share-import-status warn' },
        `这个分享已经导入过：${alreadyImported.title || alreadyImported.sessionId}。再导入会新建一个独立会话。`) : null,

      error ? h('div', { className: 'share-import-status error' },
        h('div', null, error.message),
        h('div', { style: { opacity: .7, marginTop: 4 } }, `错误代码：${error.code}`)) : null,

      result ? h('div', { className: 'share-import-status success' },
        h('div', null, `已导入会话「${result.title}」，共 ${result.rounds} 轮问答。`),
        h('div', { style: { marginTop: 4 } }, `会话 ID：${result.sessionId}`),
        h('div', { style: { opacity: .75, marginTop: 4 } },
          '如果侧边栏还没有出现它，刷新页面即可看到；打开后可以直接继续聊天。')) : null,

      h('div', { className: 'share-import-row' },
        h('button', {
          type: 'button',
          className: 'share-import-button',
          disabled: !canImport,
          onClick: runPreview,
        }, busy === 'preview' ? '预览中…' : '预览'),
        h('div', { className: 'share-import-spacer' }),
        h('button', {
          type: 'button',
          className: 'share-import-button',
          onClick: onClose,
        }, '关闭'),
        h('button', {
          type: 'button',
          className: 'share-import-button primary',
          disabled: !canImport,
          onClick: () => runImport(false),
        }, busy === 'import' ? '导入中…' : '导入')),
      alreadyImported
        ? h('div', { className: 'share-import-row' },
          h('div', { className: 'share-import-spacer' }),
          h('button', {
            type: 'button',
            className: 'share-import-button',
            disabled: !canImport,
            onClick: () => runImport(true),
          }, '仍然导入为新会话'))
        : null,
      h('p', { className: 'share-import-note' },
        '导入过程不读取任何 DeepSeek 账号凭据，也不会向模型发送消息。')))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The theme service owns the real light/dark decision; `readTheme` only
        // covers the first render before this bridge has a value.
        let themeService
        ctx.inject(['theme'], (scope) => { themeService = scope.theme })
        const themeEnvironment = {
          read() {
            try {
              const scheme = themeService?.getTheme?.()?.active?.colorScheme
              return scheme === 'dark' || scheme === 'light' ? scheme : null
            } catch {
              return null
            }
          },
          subscribe(listener) {
            if (typeof ctx.on !== 'function') return undefined
            try {
              const dispose = ctx.on('theme/change', () => listener())
              return typeof dispose === 'function' ? dispose : undefined
            } catch {
              // An unexpected event contract must not break the panel; the DOM
              // observer in `useTheme` still tracks the change.
              return undefined
            }
          },
        }

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-share-link-import',
          order: 40,
          label: () => '分享导入',
        }, (props) => h(FooterAction, { ...props, themeEnvironment })))
      },
    }
  },
})
