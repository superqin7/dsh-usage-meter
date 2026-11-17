# dsh-usage-meter

**English** | [简体中文](README.zh.md)

A token usage and cost meter for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Today's token count sits at the sidebar foot as a split-flap counter. One click opens a panel with the estimated cost, the cache-hit figures, and a per-model breakdown for the day.

Everything is computed from the session logs Harness already writes. The plugin reads no invoice, takes no account credentials, and sends nothing anywhere.

## What it shows

**Sidebar foot** — `glyph · 今日消耗token：79,825,490` (`Today: 79,825,490` in English). In the collapsed 56px rail only the glyph remains. Digits flip like an old calendar counter, and only the positions that changed move.

**The panel** — click the reading:

| | |
|---|---|
| Today's tokens | flip-counter, large |
| Estimated cost | same weight, accent color |
| Cache hit rate | cache reads as a share of prompt-side tokens |
| Input | all prompt-side tokens (uncached + cache reads + cache writes) |
| Output | completion tokens |
| Cache reads | prompt-side tokens served from cache |
| By model (today) | one row per model: name, token count, cost |

`Escape` closes it; the header has refresh and close buttons.

## Install

Requires DeepSeek Harness 0.2.x and a profile to install into.

```sh
# Web build
dsh plugin --profile web add github:superqin7/dsh-usage-meter

# Desktop build (its bundled CLI, desktop profile)
dsh plugin --profile desktop add github:superqin7/dsh-usage-meter
```

Pin a release:

```sh
dsh plugin --profile web add github:superqin7/dsh-usage-meter#v1.1.1
```

A local checkout works the same way:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-usage-meter
```

Restart `dsh web` (or the desktop app) after installing or updating. Client-side changes also need one **page reload** before they appear.

## Configure prices

The plugin config lives in `cordis.patch.yml` beside the package. Rates are **currency units per one million tokens**.

```yaml
- id: usage-meter
  name: dsh-usage-meter
  config:
    route: /plugin/usage-meter/summary
    currency: CNY
    allowRemote: false          # serve loopback callers only
    cacheReadRatio: 0.1         # fallback when a card omits cacheRead
    holidays: ["2026-10-01"]    # Asia/Shanghai dates priced off-peak all day
    unpricedModels: ["my-private-model"]
    prices:
      deepseek-flash:
        input: 2          # cache-miss input, peak tariff
        cacheRead: 0.04   # cache-hit input, peak tariff
        output: 8         # output, peak tariff
        offPeakRatio: 0.5 # off-peak multiplier; omit for a flat tariff
      qwen3.8-flash:
        input: 0.8
        cacheRead: 0.1
        output: 2.7
    # Fallback for models missing from `prices`.
    defaultPrice: { input: 2, cacheRead: 0.04, output: 8, offPeakRatio: 0.5 }
```

| Key | Meaning |
|---|---|
| `route` | Exact HTTP path for the JSON summary |
| `currency` | Display symbol: `CNY`, `USD`, `EUR`, or anything else (no symbol) |
| `allowRemote` | Serve non-loopback callers; defaults to `false` |
| `prices` | Per-model `input` / `output`, plus optional `cacheRead` / `cacheWrite` |
| `prices.*.offPeakRatio` | Multiplier applied to every rate outside peak windows; defaults to `1` |
| `cacheReadRatio` | Cache-read price as a fraction of the input price, when a model omits `cacheRead` |
| `holidays` | `YYYY-MM-DD` dates treated as off-peak all day |
| `unpricedModels` | Models that report tokens but no cost, instead of inheriting `defaultPrice` |
| `defaultPrice` | Card used for models absent from `prices` |

### Peak and off-peak tariffs

Some providers bill by time of day. When a model sets `offPeakRatio`, every
usage record is classified by **its own timestamp** rather than at request time,
so a session that spans a boundary is split correctly.

The shipped schedule matches DeepSeek's: **Asia/Shanghai, Monday to Friday,
09:00-12:00 and 14:00-18:00** are peak. Weekends are off-peak all day, and so is
any date in `holidays`. Models that do not set `offPeakRatio` ignore the
schedule entirely.

DeepSeek publishes off-peak as half of peak (`offPeakRatio: 0.5`), and excludes
The shipped `holidays` list covers mainland China's public holidays for **2026 and 2027**, which is what DeepSeek excludes from its peak tariff. The 2027 dates are provisional until the State Council publishes that year's schedule; update the list when it does. Adjusted make-up workdays are deliberately absent, because the published rule only names Monday to Friday as peak.

### Shipped rates (verified 2026-11-17)

These are each vendor's **public list price**, in CNY per one million tokens. They are the defaults this repository ships, so the meter reports a real cost without any setup.

| Model | Input (cache miss) | Cache hit | Output | Tariff |
|---|---|---|---|---|
| `deepseek-flash` | ¥2 | ¥0.04 | ¥8 | peak / off-peak 0.5× |
| `deepseek-v4-pro` | ¥9 | ¥0.30 | ¥27 | peak / off-peak 0.5× |
| `qwen3.8-flash` | ¥0.8 | ¥0.1 | ¥2.7 | flat |
| `qwen3.8-27b` | ¥3 | ¥0.6 | ¥12 | flat |
| `qwen3.8-max` | ¥12 | ¥1.5 | ¥36 | flat |
| `glm-5.3-flash` | ¥0.8 | ¥0.23 | ¥2.8 | flat |
| `glm-5.3` | ¥8 | ¥2 | ¥28 | flat |
| `kimi-k3` | ¥20 | ¥2 | ¥100 | flat |
| `MiniMax-M3` | ¥2.1 | ¥0.42 | ¥8.4 | flat (see caveat) |
| `MiniMax-H3-Image-PE` | ¥15 | — | — | input only |

Sources:

- DeepSeek — <https://api-docs.deepseek.com/zh-cn/quick_start/pricing>
- Alibaba Bailian (华北2 北京) — `help.aliyun.com/zh/model-studio/qwen3-8-{flash,max,27b}`
- Zhipu — <https://docs.bigmodel.cn/cn/guide/start/pricing>
- Moonshot — <https://platform.kimi.com/docs/pricing/chat>
- MiniMax — <https://platform.minimax.cn/docs/pricing/overview>

Caveats on the table above:

- **MiniMax-M3 is length-tiered, not flat.** Inputs above 512K tokens cost double (¥4.2 / ¥0.84 / ¥16.8). The plugin prices every call at the ≤512K rate, so a session that pushes a very long prompt is undercounted. The figure is also the current 50%-off promotional list price.
- **MiniMax-H3-Image-PE is not a public model id.** It maps to MiniMax's `H3-Image-Context-IR` prompt-enhancement billing: input only, no output charge, no cache tier.
- **Self-hosted models are sold no public rate.** `nvidia/Qwen3.6-35B-A3B-NVFP4` and `Qwen/Qwen3.8-27B-FP8` are private deployments, so they are listed in `unpricedModels`: they show tokens and no cost rather than borrowing a fallback card and inventing one.
- **`kimi-k3` cache writes** are quoted separately (¥20 for 5-minute, ¥40 for 1-hour). The card uses the input rate, which matches the 5-minute tier.

### Two details worth knowing

- **Cache reads dominate a long session.** In practice more than 95% of prompt-side tokens are cache hits, so `cacheRead` moves the total far more than `output` does. A cache-hit rate that is off by a factor of five changes the estimate more than any other mistake.
- **A model id must match exactly.** The id comes from the `assistant/message` event's model identity, which is what the provider adapter reports — usually the same string shown in the model picker.

## How the numbers are computed

The Host half folds every `assistant/message` event that carries `usage` into buckets keyed by **local day × model × tariff**:

```
uncachedInput += usage.inputTokens
cacheRead     += usage.cacheReadTokens
cacheWrite    += usage.cacheWriteTokens
output        += usage.outputTokens
```

Live sessions are folded incrementally: only the new tail of the log is read on each request. A cold session is read once through `sessionQuery.readSession` and then cached, because a finished log cannot change until the session becomes live again.

The summary is served as JSON on the configured route, and the Client half polls it every 4 seconds while the plugin is loaded.

Cost is computed per bucket, then combined:

```
peak = uncachedInput_p × input + cacheRead_p × cacheRead + cacheWrite_p × cacheWrite + output_p × output
off  = uncachedInput_o × input + cacheRead_o × cacheRead + cacheWrite_o × cacheWrite + output_o × output
cost = (peak + off × offPeakRatio) / 1e6
```

## Troubleshooting

1. **The sidebar shows `—`.** The Client cannot read the summary. Find the web port (`dsh web` prints it at startup) and hit the route directly:

   ```sh
   curl http://127.0.0.1:<port>/plugin/usage-meter/summary
   ```

   `200` with JSON means the Host half is fine. A `500` carries `{"error": "..."}` explaining why.

2. **Every cost is `—`.** The model id is not in `prices` and there is no `defaultPrice`. Read `models[].model` out of the JSON and copy that exact id into the config.

3. **A price change had no effect.** Prices are applied per request and take effect immediately. `holidays` is different: peak classification is folded into cached buckets, so changing it rebuilds them on the next request — restart the plugin if you want to be certain.

4. **The estimate looks too high.** Check `cacheRead` first. Cache hits are the overwhelming majority of tokens, so an error there dominates the total.

## Limitations

- **The cost is an estimate.** It never reads a provider invoice or account balance, and it cannot reconcile against one.
- **No non-token cost.** Image generation, storage, per-request fees, and anything billed outside token counts are invisible here.
- **One card per model, one currency.** No peak/off-peak tiers, no per-request minimums.
- **The route answers loopback callers only** unless `allowRemote: true`. It exposes session counts, working directories of sessions with usage, and token totals — not conversation content.
- **History is not retained.** The plugin keeps no database; it recomputes from session logs, so the numbers follow the logs. Delete session data and the totals drop with it.
- **Windows, macOS, and Linux behave the same**, as long as `node` runs the Harness.

## Development

The package is plain ESM with no build step and no dependencies. `index.js` is the Host half, `client.js` the browser module, `cordis.patch.yml` the loader patch.

```
index.js            Host: folding, pricing, HTTP route
client.js           Client: sidebar entry, panel, flip digits
cordis.patch.yml    Loader row and the default rate table
locale/{en,zh}.json Plugin Manager metadata
docs/DETAIL.md      Bundle detail page
```

## License

MIT
