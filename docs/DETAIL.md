# Token usage meter

Answers one question: how many tokens has this Harness spent today, and roughly what did they cost.

## Where it shows up

- **Sidebar foot** — a split-flap counter: `79,825,490`. In the collapsed rail only the glyph remains. Digits flip like an old calendar; only the positions that changed move, rightmost first.
- **Click it** — a panel opens above the sidebar foot with:
  - today's token count, as flip digits
  - the estimated cost
  - cache hit rate, input, output, and cache reads
  - one row per model used today: name, token count, cost

Nothing is rendered in the conversation flow.

## Where the numbers come from

The Host half folds every `assistant/message` event that carries `usage` into buckets keyed by local day, model, and peak/off-peak tariff. The four usage buckets are disjoint: uncached input, cache read, cache write, and output.

Live sessions are folded incrementally from the in-memory log — only the new tail is read per request. A cold session is read once through `sessionQuery.readSession` and then cached, because a finished log cannot change until that session becomes live again.

The summary is served as JSON on `GET /plugin/usage-meter/summary`, and the Client polls it every four seconds.

## Cost

Cost comes from the rate table in the plugin config, in currency units **per one million tokens**, with `input` meaning the cache-miss rate:

```yaml
- id: usage-meter
  name: dsh-usage-meter
  config:
    currency: CNY
    holidays: []
    prices:
      deepseek-flash: { input: 2, cacheRead: 0.04, output: 8, offPeakRatio: 0.5 }
      qwen3.8-flash: { input: 0.8, cacheRead: 0.1, output: 2.7 }
    defaultPrice: { input: 2, cacheRead: 0.04, output: 8, offPeakRatio: 0.5 }
```

A model that omits `cacheRead` falls back to `cacheReadRatio` × its input rate.

### Peak and off-peak tariffs

Each usage record is classified by **its own timestamp**, not at request time, so a session that spans a peak boundary is split correctly. The shipped schedule matches DeepSeek's: **Asia/Shanghai, Monday to Friday, 09:00-12:00 and 14:00-18:00** are peak; weekends are off-peak all day; so is any date in `holidays`.

Models without `offPeakRatio` ignore the schedule entirely.

The plugin ships **no holiday calendar**. DeepSeek excludes Chinese public holidays from peak, so add them to `holidays` for exact numbers; without them, a holiday weekday is priced at peak rates.

### Cache reads dominate a long session

More than 95% of prompt-side tokens are typically cache hits, so the cache-hit rate drives the estimate: it can be one-fiftieth of the input rate. Getting it wrong by a factor of five is a bigger error than any other mistake in the table.

## Limitations

- **The cost is an estimate.** It never reads a provider invoice or account balance, and it cannot reconcile against one.
- **One card per model.** Length-tiered pricing (MiniMax-M3 above 512K input), batch discounts, and priority tiers are all priced as the standard listed rate.
- **No non-token cost.** Image output, search calls, file parsing, storage, and per-request fees are invisible here.
- **The route is unauthenticated.** It binds wherever the Harness web server binds and any local process can read token totals, session counts, and the working directories of sessions with usage — not conversation content.
- **History follows the logs.** The plugin keeps no database; delete session data and the totals drop with it.
