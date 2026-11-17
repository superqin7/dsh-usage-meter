# dsh-usage-meter

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
dsh plugin --profile web add github:superqin7/dsh-usage-meter
```

A local checkout works the same way:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-usage-meter
```

Restart `dsh web` after installing or updating. The Desktop app uses its bundled CLI and the `desktop` profile.

## Configure prices

The plugin config lives in `cordis.patch.yml` beside the package. Rates are **currency units per one million tokens**.

```yaml
- id: usage-meter
  name: dsh-usage-meter
  config:
    route: /plugin/usage-meter/summary
    currency: CNY
    # Cache reads are not always quoted by a provider. A model without an
    # explicit `cacheRead` is priced at this fraction of its input rate.
    cacheReadRatio: 0.1
    prices:
      deepseek-flash: { input: 2, output: 8 }
      # Any model id the events report can be listed here.
    # Fallback for models missing from `prices`.
    defaultPrice: { input: 2, output: 8 }
```

| Key | Meaning |
|---|---|
| `route` | Exact HTTP path for the JSON summary |
| `currency` | `CNY`, `USD`, `EUR`, or anything else (no symbol) |
| `prices` | Per-model `input` / `output`, plus optional `cacheRead` / `cacheWrite` |
| `cacheReadRatio` | Cache-read price as a fraction of the input price |
| `defaultPrice` | Card used for models absent from `prices` |

Two details worth knowing:

- **Cache reads dominate a long session.** In practice more than 95% of prompt-side tokens are cache hits, so `cacheRead` (and therefore `cacheReadRatio`) moves the total far more than `output` does. If your provider publishes an explicit cache-hit price, set `cacheRead` per model instead of relying on the ratio.
- **A model id must match exactly.** The id comes from the `assistant/message` event's model identity, which is what the provider adapter reports — usually the same string shown in the model picker.

## How the numbers are computed

The Host half folds every `assistant/message` event that carries `usage` into buckets keyed by **local day × model**:

```
uncachedInput += usage.inputTokens
cacheRead     += usage.cacheReadTokens
cacheWrite    += usage.cacheWriteTokens
output        += usage.outputTokens
```

Live sessions are folded incrementally: only the new tail of the log is read on each request. A cold session is read once through `sessionQuery.readSession` and then cached, because a finished log cannot change until the session becomes live again.

The summary is served as JSON on the configured route, and the Client half polls it every 4 seconds while the plugin is loaded.

Cost is `(uncachedInput × input + cacheRead × cacheRead + cacheWrite × cacheWrite + output × output) / 1e6`, summed per model.

## Limitations

- **The cost is an estimate.** It never reads a provider invoice or account balance, and it cannot reconcile against one.
- **No non-token cost.** Image generation, storage, per-request fees, and anything billed outside token counts are invisible here.
- **One card per model, one currency.** No peak/off-peak tiers, no per-request minimums.
- **The route is unauthenticated.** It binds wherever the Harness web server binds (loopback by default) and any local process can read it. It exposes session counts, working directories of sessions with usage, and token totals — not conversation content. Change `route` if that matters.
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
