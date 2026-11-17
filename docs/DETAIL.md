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

The Host half folds every `assistant/message` event that carries `usage` into buckets keyed by local day and model. The four buckets are disjoint: uncached input, cache read, cache write, and output.

Live sessions are folded incrementally from the in-memory log — only the new tail is read per request. A cold session is read once through `sessionQuery.readSession` and then cached, because a finished log cannot change until that session becomes live again.

The summary is served as JSON on `GET /plugin/usage-meter/summary`, and the Client polls it every four seconds.

## Cost

Cost comes from the rate table in the plugin config, in currency units **per one million tokens**:

```yaml
- id: usage-meter
  name: dsh-usage-meter
  config:
    currency: CNY
    cacheReadRatio: 0.1
    prices:
      deepseek-flash: { input: 2, output: 8 }
    defaultPrice: { input: 2, output: 8 }
```

`cost = (uncachedInput × input + cacheRead × cacheRead + cacheWrite × cacheWrite + output × output) / 1e6`, summed per model.

Cache reads dominate a long session: more than 95% of prompt-side tokens are typically cache hits, so the cache-read rate moves the total far more than the output rate does. A model without an explicit `cacheRead` is priced at `cacheReadRatio` times its input rate; set `cacheRead` per model when your provider publishes an exact cache-hit price.

Remove the card entirely to show tokens only — the panel then reports `—` for cost.

## Limitations

- **The cost is an estimate, not a bill.** It never reads a provider invoice or account balance.
- **No non-token cost.** Image generation, storage, and per-request fees are invisible here.
- **The route is unauthenticated.** It binds wherever the Harness web server binds and any local process can read token totals, session counts, and the working directories of sessions with usage — not conversation content.
- **History follows the logs.** The plugin keeps no database; delete session data and the totals drop with it.
