/**
 * Client half of the usage meter.
 *
 * Two registrations share one observable store: a compact "today" reading at
 * the sidebar foot, and the panel it opens in the frame-wide overlay layer.
 * The reading uses split-flap digits: only the positions that changed flip, so
 * a running Session reads like an old calendar counter rather than a value
 * being swapped out.
 */

window.__ModuleLoader__.load({
  id: 'dsh-usage-meter',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ROUTE = '/plugin/usage-meter/summary'
    const NS = 'dsh-usage-meter'
    /** Poll interval; the Host folds only changed tails, so this stays cheap. */
    const TICK_MS = 4000
    /** One flap's animation length, matching the keyframes in `Styles`. */
    const FLIP_MS = 360
    /** One size for the glyph, the label and the digits. */
    const ENTRY_FONT_PX = 14

    /** Immutable view state. */
    let snapshot = { open: false, data: null, error: null, loading: false }
    const listeners = new Set()

    /**
     * Replace part of the snapshot and notify subscribers.
     * @param patch - fields to replace.
     */
    function set(patch) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener()
    }

    /** Subscribe to snapshot changes. */
    function subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }

    /** Read the current snapshot. */
    function getSnapshot() {
      return snapshot
    }

    /** Fetch the Host summary, replacing view state. */
    async function load() {
      set({ loading: true })
      try {
        const response = await fetch(ROUTE, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        set({ data: await response.json(), error: null, loading: false })
      } catch (error) {
        set({ error: String(error?.message ?? error), loading: false })
      }
    }

    /**
     * Exact integer with thousands separators.
     * @param value - number.
     * @returns display text.
     */
    function formatInt(value) {
      if (!Number.isFinite(value)) return '—'
      return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /**
     * Money with the precision the magnitude deserves.
     * @param value - amount, or null when unpriced.
     * @param currency - ISO code from the Host config.
     * @returns display text.
     */
    function formatCost(value, currency) {
      if (value === null || value === undefined) return '—'
      const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : ''
      const digits = value > 0 && value < 0.01 ? 4 : 2
      return `${symbol}${value.toFixed(digits)}`
    }

    /**
     * Percentage of prompt-side tokens served from cache.
     * @param rate - ratio, or null.
     * @returns display text.
     */
    function formatPercent(rate) {
      if (rate === null || rate === undefined) return '—'
      return `${(rate * 100).toFixed(1)}%`
    }

    /** Localized text with an inline fallback, so a missing key never blanks UI. */
    let translate = (_key, fallback) => fallback

    /** Small meter glyph. */
    function Glyph(props) {
      const size = props.size ?? ENTRY_FONT_PX
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size,
        'aria-hidden': true, style: { display: 'block', flex: 'none' },
      }, h('path', {
        d: 'M2.5 13V9.5M6.5 13V6.5M10.5 13V8M14 13V3.5',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round',
      }))
    }

    /**
     * One split-flap digit card. It keeps its own previous glyph and replays the
     * flap animation only when its character actually changes, so digit
     * positions that did not change stay perfectly still.
     * @param props - `char`, stagger `delay`, and a size `scale`.
     */
    function FlipDigit(props) {
      const previous = React.useRef(props.char)
      const [flipping, setFlipping] = React.useState(false)
      React.useEffect(() => {
        if (previous.current === props.char) return undefined
        previous.current = props.char
        setFlipping(true)
        const stop = setTimeout(() => setFlipping(false), FLIP_MS + props.delay)
        return () => clearTimeout(stop)
      }, [props.char, props.delay])
      const className = flipping ? 'dsh-usage-meter-digit is-flipping' : 'dsh-usage-meter-digit'
      return h('span', {
        className,
        style: { animationDelay: `${props.delay}ms` },
      }, props.char)
    }

    /**
     * A formatted count rendered as flip cards. Separators render as static
     * glyphs; digits stagger from the units position leftwards.
     * @param props - `value`, plus a `scale` (`sm` entry, `lg` panel).
     */
    function FlipNumber(props) {
      const characters = [...formatInt(props.value)]
      const reversed = [...characters].reverse()
      const tail = reversed.findIndex((character) => character >= '0' && character <= '9')
      const lastDigit = Math.max(0, characters.length - 1 - tail)
      const children = []
      for (let index = 0; index < characters.length; index += 1) {
        const char = characters[index]
        if (char >= '0' && char <= '9') {
          // Rightmost digit flaps first, like a mechanical counter.
          const delay = Math.max(0, Math.min(5, lastDigit - index)) * 26
          children.push(h(FlipDigit, { key: `d${index}`, char, delay }))
        } else {
          children.push(h('span', { key: `s${index}`, className: 'dsh-usage-meter-sep' }, char))
        }
      }
      return h('span', { className: 'dsh-usage-meter-flip', 'data-scale': props.scale ?? 'sm' }, children)
    }

    /** A small ghost icon button. */
    function IconButton(props) {
      return h('button', {
        type: 'button',
        className: 'dsh-usage-meter-icon',
        title: props.label,
        'aria-label': props.label,
        onClick: props.onClick,
      }, h('svg', { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true },
        h('path', {
          d: props.path,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        })))
    }

    /** One labelled statistic cell. */
    function Cell(props) {
      return h('div', { className: 'dsh-usage-meter-cell' },
        h('dt', null, props.label),
        h('dd', null, props.value))
    }

    /** One model row: name, token count, cost. */
    function ModelRow(props) {
      return h('div', { className: 'dsh-usage-meter-row' },
        h('span', { className: 'dsh-usage-meter-model', title: props.model }, props.model),
        h('span', { className: 'dsh-usage-meter-tokens' }, `${formatInt(props.tokens)} token`),
        h('span', { className: 'dsh-usage-meter-money' }, props.cost))
    }

    /** Shared style block; component-local, removed on unmount. */
    function Styles() {
      return h('style', null, [
        '.dsh-usage-meter-btn{display:flex;align-items:center;gap:8px;min-width:0;height:30px;padding:0 10px 0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-text-secondary,#666);font-family:inherit;font-size:14px;font-weight:500;line-height:1;cursor:pointer;white-space:nowrap}',
        '.dsh-usage-meter-btn:hover{background:var(--dsw-alias-surface-hover,rgba(128,128,128,.12));color:var(--dsw-alias-text-primary,#111)}',
        '.dsh-usage-meter-btn[data-open="true"]{background:var(--dsw-alias-surface-hover,rgba(128,128,128,.12));color:var(--dsw-alias-text-primary,#111)}',
        '.dsh-usage-meter-label{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:14px;font-weight:500;opacity:.62}',
        '.dsh-usage-meter-flip{display:inline-flex;align-items:center;perspective:160px}',
        '.dsh-usage-meter-digit{display:inline-flex;align-items:center;justify-content:center;position:relative;font-variant-numeric:tabular-nums;transform-origin:50% 100%;backface-visibility:hidden}',
        '.dsh-usage-meter-digit::after{content:"";position:absolute;left:6%;right:6%;top:50%;height:1px;background:currentColor;opacity:.16;pointer-events:none}',
        '.dsh-usage-meter-digit.is-flipping{animation:dsh-usage-meter-flap .36s cubic-bezier(.32,1.32,.48,1) both}',
        '.dsh-usage-meter-flip[data-scale="sm"]{font-size:14px;font-weight:600}',
        '.dsh-usage-meter-flip[data-scale="sm"] .dsh-usage-meter-digit{width:.62em}',
        '.dsh-usage-meter-flip[data-scale="lg"]{font-size:23px;font-weight:700}',
        '.dsh-usage-meter-flip[data-scale="lg"] .dsh-usage-meter-digit{width:.62em}',
        '.dsh-usage-meter-sep{opacity:.45;font-variant-numeric:tabular-nums}',
        '@keyframes dsh-usage-meter-flap{0%{transform:rotateX(-86deg);opacity:.25}60%{transform:rotateX(7deg);opacity:1}100%{transform:rotateX(0);opacity:1}}',
        '@media (prefers-reduced-motion: reduce){.dsh-usage-meter-digit.is-flipping{animation:none}}',
        '.dsh-usage-meter-panel{position:fixed;left:12px;bottom:58px;width:356px;max-height:min(78vh,600px);display:flex;flex-direction:column;pointer-events:auto;border:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.28));border-radius:12px;background:var(--dsw-alias-surface-background,#fff);box-shadow:0 12px 32px rgba(0,0,0,.18);color:var(--dsw-alias-text-primary,#111);font-size:12px;overflow:hidden;z-index:60}',
        '.dsh-usage-meter-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.2))}',
        '.dsh-usage-meter-title{flex:1;font-weight:600;font-size:12px}',
        '.dsh-usage-meter-icon{display:flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;opacity:.75}',
        '.dsh-usage-meter-icon:hover{opacity:1;background:var(--dsw-alias-surface-hover,rgba(128,128,128,.14))}',
        '.dsh-usage-meter-body{padding:12px;overflow:auto}',
        '.dsh-usage-meter-hero{display:grid;grid-template-columns:1fr auto;align-items:end;gap:12px;padding:10px 12px;margin-bottom:10px;border-radius:10px;background:var(--dsw-alias-surface-raised,rgba(128,128,128,.08))}',
        '.dsh-usage-meter-hero-label{opacity:.62;font-size:11px;margin:0 0 4px}',
        '.dsh-usage-meter-cost{text-align:right}',
        '.dsh-usage-meter-cost-value{font-size:23px;font-weight:700;line-height:1.1;font-variant-numeric:tabular-nums;color:var(--dsw-alias-status-info,#1f6feb);letter-spacing:-.4px}',
        '.dsh-usage-meter-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 8px}',
        '.dsh-usage-meter-cell{padding:7px 9px;border-radius:8px;background:var(--dsw-alias-surface-raised,rgba(128,128,128,.08))}',
        '.dsh-usage-meter-cell dt{opacity:.62;font-size:11px;margin:0 0 3px}',
        '.dsh-usage-meter-cell dd{margin:0;font-weight:600;font-size:13px;font-variant-numeric:tabular-nums}',
        '.dsh-usage-meter-note{opacity:.62;line-height:1.5;margin:0 0 6px}',
        '.dsh-usage-meter-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--dsw-alias-border-subtle,rgba(128,128,128,.14))}',
        '.dsh-usage-meter-model{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dsh-usage-meter-tokens{font-variant-numeric:tabular-nums;opacity:.75;white-space:nowrap}',
        '.dsh-usage-meter-money{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap;min-width:86px;text-align:right}',
        '.dsh-usage-meter-error{color:var(--dsw-alias-status-danger,#c0392b);line-height:1.5}',
      ].join('\n'))
    }

    /** Sidebar-foot entry: today's tokens as flip cards, click toggles the panel. */
    function MeterEntry(props) {
      const state = React.useSyncExternalStore(subscribe, getSnapshot)
      const today = state.data?.today
      const wide = props.wide !== false
      const label = translate('entry.today', '今日消耗token：')
      const title = translate('entry.title', 'Token 用量与花费')
      const reading = today === undefined || today === null
        ? h('span', { className: 'dsh-usage-meter-flip', 'data-scale': 'sm' }, '—')
        : h(FlipNumber, { value: today.tokens, scale: 'sm' })
      const children = [h(Glyph, { key: 'g' })]
      if (wide) {
        children.push(h('span', { key: 'l', className: 'dsh-usage-meter-label' }, label))
        children.push(h('span', { key: 'n' }, reading))
      }
      return h('button', {
        type: 'button',
        className: 'dsh-usage-meter-btn',
        title: title,
        'aria-label': `${title} ${label}${today === undefined || today === null ? '—' : formatInt(today.tokens)}`,
        'aria-expanded': state.open ? 'true' : 'false',
        'data-open': state.open ? 'true' : 'false',
        onClick: () => {
          const open = !snapshot.open
          set({ open })
          if (open) void load()
        },
      }, children)
    }

    /** Frame-wide panel; renders nothing until the entry opens it. */
    function MeterPanel() {
      const state = React.useSyncExternalStore(subscribe, getSnapshot)
      const open = state.open
      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => { if (event.key === 'Escape') set({ open: false }) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])
      if (!open) return null

      const data = state.data
      const today = data?.today ?? null
      const currency = data?.currency
      const title = translate('panel.title', 'Token 用量统计')

      const head = h('div', { className: 'dsh-usage-meter-head' },
        h(Glyph, { size: 14 }),
        h('span', { className: 'dsh-usage-meter-title' }, title),
        h(IconButton, {
          key: 'refresh',
          label: translate('panel.refresh', '刷新'),
          path: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5.5H10',
          onClick: () => { void load() },
        }),
        h(IconButton, {
          key: 'close',
          label: translate('panel.close', '关闭'),
          path: 'M4 4l8 8M12 4l-8 8',
          onClick: () => set({ open: false }),
        }))

      const body = []
      if (state.error !== null) {
        body.push(h('p', { key: 'err', className: 'dsh-usage-meter-error' },
          `${translate('panel.failed', '读取用量失败')}：${state.error}`))
      }
      if (today === null) {
        body.push(h('p', { key: 'loading', className: 'dsh-usage-meter-note' },
          state.loading ? translate('panel.loading', '正在读取…') : translate('panel.empty', '暂无数据')))
      } else {
        body.push(h('div', { key: 'hero', className: 'dsh-usage-meter-hero' },
          h('div', null,
            h('p', { className: 'dsh-usage-meter-hero-label' }, translate('panel.today', '今日消耗 token')),
            h(FlipNumber, { value: today.tokens, scale: 'lg' })),
          h('div', { className: 'dsh-usage-meter-cost' },
            h('p', { className: 'dsh-usage-meter-hero-label' }, translate('panel.estimate', '预估花费')),
            h('div', { className: 'dsh-usage-meter-cost-value' }, formatCost(today.cost, currency)))))
        body.push(h('dl', { key: 'grid', className: 'dsh-usage-meter-grid' },
          h(Cell, { key: 'cache', label: translate('panel.cacheHit', '缓存命中率'), value: formatPercent(today.cacheHitRate) }),
          h(Cell, { key: 'in', label: translate('panel.input', '输入'), value: formatInt(today.billedInput) }),
          h(Cell, { key: 'out', label: translate('panel.output', '输出'), value: formatInt(today.output) }),
          h(Cell, { key: 'cached', label: translate('panel.cacheHits', '缓存命中数'), value: formatInt(today.cacheRead) })))
        const models = data.models ?? []
        if (models.length > 0) {
          body.push(h('p', { key: 'byLabel', className: 'dsh-usage-meter-note', style: { marginTop: 6, marginBottom: 0 } },
            translate('panel.byModel', '按模型（今日）')))
          for (const entry of models) {
            body.push(h(ModelRow, {
              key: entry.model,
              model: entry.model,
              tokens: entry.tokens,
              cost: entry.priced === false
                ? translate('panel.unpricedModel', '自建 · 未定价')
                : formatCost(entry.cost, currency),
            }))
          }
        }
        if (data.priced === false) {
          body.push(h('p', { key: 'unpriced', className: 'dsh-usage-meter-note', style: { marginTop: 8 } },
            translate('panel.unpriced', '未配置价目表，仅显示 token。')))
        }
      }

      return h('div', {
        className: 'dsh-usage-meter-panel',
        role: 'dialog',
        'aria-label': title,
      }, head, h('div', { className: 'dsh-usage-meter-body' }, body))
    }

    /** Dictionary pair registered with the Client locale service. */
    const DICTIONARY = {
      en: {
        'entry.today': 'Today: ',
        'entry.title': 'Token usage and cost',
        'panel.title': 'Token usage',
        'panel.today': "Today's tokens",
        'panel.estimate': 'Estimated cost',
        'panel.refresh': 'Refresh',
        'panel.close': 'Close',
        'panel.loading': 'Reading…',
        'panel.empty': 'No data yet',
        'panel.failed': 'Could not read usage',
        'panel.cacheHit': 'Cache hit rate',
        'panel.cacheHits': 'Cache reads',
        'panel.input': 'Input',
        'panel.output': 'Output',
        'panel.byModel': 'By model (today)',
        'panel.unpriced': 'No price configured for these models.',
        'panel.unpricedModel': 'unpriced',
      },
      zh: {
        'entry.today': '今日消耗token：',
        'entry.title': 'Token 用量与花费',
        'panel.title': 'Token 用量统计',
        'panel.today': '今日消耗 token',
        'panel.estimate': '预估花费',
        'panel.refresh': '刷新',
        'panel.close': '关闭',
        'panel.loading': '正在读取…',
        'panel.empty': '暂无数据',
        'panel.failed': '读取用量失败',
        'panel.cacheHit': '缓存命中率',
        'panel.cacheHits': '缓存命中数',
        'panel.input': '输入',
        'panel.output': '输出',
        'panel.byModel': '按模型（今日）',
        'panel.unpriced': '部分模型未配置价格。',
        'panel.unpricedModel': '自建 · 未定价',
      },
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          for (const locale of Object.keys(DICTIONARY)) {
            ctx.locale.register(NS, locale, DICTIONARY[locale])
          }
          const bound = ctx.locale.bind(NS)
          translate = (key, fallback) => {
            try {
              const value = bound(key)
              return value === undefined || value === null || value === '' ? fallback : value
            } catch {
              return fallback
            }
          }
        } catch (error) {
          console.warn('[dsh-usage-meter] locale registration failed', error)
        }

        ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'usage-meter',
          order: 20,
          label: () => translate('entry.title', 'Token 用量与花费'),
        }, (props) => h(React.Fragment, null, h(Styles, null), h(MeterEntry, props)))), 'dsh-usage-meter: sidebar entry')

        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'usage-meter.panel',
          order: 20,
        }, (props) => h(React.Fragment, null, h(Styles, null), h(MeterPanel, props)))), 'dsh-usage-meter: panel')

        // One tick for the whole plugin so the sidebar reading keeps flipping.
        ctx.effect(() => {
          void load()
          const stop = setInterval(() => { void load() }, TICK_MS)
          return () => clearInterval(stop)
        }, 'dsh-usage-meter: poll')
      },
    }
  },
})
