/**
 * Host half of the usage meter.
 *
 * Folds every `assistant/message` usage record into local-day, per-model
 * buckets, prices them with the configured rate table, and serves the result as
 * JSON on one exact route so the Client half can read today's total and the
 * model breakdown.
 *
 * Live Sessions are folded incrementally from the in-memory log; a cold Session
 * is read once through `sessionQuery.readSession` and then cached, because its
 * log cannot change until it becomes live again.
 */

/** Services required before this plugin activates. Deliberately minimal: the
 * route carrier, the Session corpus, and the live registry used to fold a
 * running Session's tail incrementally. */
export const inject = [
  'webServer',
  'sessionQuery',
  'sessions',
]

/** Fallback route when the patch omits one. */
const DEFAULT_ROUTE = '/plugin/usage-meter/summary'

/** Model name used when an event carries no model identity. */
const UNKNOWN_MODEL = 'unknown'

/**
 * Local calendar day key for one instant.
 * @param time - epoch milliseconds.
 * @returns `YYYY-MM-DD` in the Host's local zone.
 */
function dayKey(time) {
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Token buckets with no counts. */
function emptyUsage() {
  return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }
}

/** One empty day bucket: usage plus turn/step counters and a per-model map. */
function emptyDay() {
  return { ...emptyUsage(), turns: 0, steps: 0, models: new Map() }
}

/**
 * Add one usage record into a bucket.
 * @param target - bucket to advance.
 * @param usage - provider-reported usage.
 */
function addUsage(target, usage) {
  target.uncachedInput += usage.inputTokens ?? 0
  target.cacheRead += usage.cacheReadTokens ?? 0
  target.cacheWrite += usage.cacheWriteTokens ?? 0
  target.output += usage.outputTokens ?? 0
  target.calls += 1
}

/**
 * Add one event's contribution to a day-bucket map.
 * @param days - map of day key to day bucket.
 * @param event - one committed Session event.
 */
function foldInto(days, event) {
  const type = event?.type
  if (type === 'turn/start' || type === 'step/start') {
    const key = dayKey(event.time)
    const bucket = days.get(key) ?? emptyDay()
    if (type === 'turn/start') bucket.turns += 1
    else bucket.steps += 1
    days.set(key, bucket)
    return
  }
  if (type !== 'assistant/message') return
  const usage = event.data?.usage
  if (usage === undefined || usage === null) return
  const model = event.data?.message?.source?.model ?? UNKNOWN_MODEL
  const key = dayKey(event.time)
  const bucket = days.get(key) ?? emptyDay()
  addUsage(bucket, usage)
  const modelBuckets = bucket.models
  const perModel = modelBuckets.get(model) ?? { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  perModel.uncachedInput += usage.inputTokens ?? 0
  perModel.cacheRead += usage.cacheReadTokens ?? 0
  perModel.cacheWrite += usage.cacheWriteTokens ?? 0
  perModel.output += usage.outputTokens ?? 0
  modelBuckets.set(model, perModel)
  days.set(key, bucket)
}

/**
 * Resolve the rate card for one model.
 * @param config - the row's config.
 * @param model - model id from the event.
 * @returns a complete per-million card, or null when the model is unpriced.
 */
function cardFor(config, model) {
  const input0 = config?.prices?.[model] ?? config?.defaultPrice
  if (input0 === undefined || input0 === null) return null
  const input = Number(input0.input)
  if (!Number.isFinite(input) || input < 0) return null
  const ratio = Number.isFinite(config?.cacheReadRatio) ? config.cacheReadRatio : 0.1
  const output = Number(input0.output)
  const cacheRead = Number(input0.cacheRead)
  const cacheWrite = Number(input0.cacheWrite)
  return {
    input,
    // The user's table quotes input/output only, so a cache read defaults to a
    // fraction of the input rate and a cache write to the full input rate.
    cacheRead: Number.isFinite(cacheRead) && cacheRead >= 0 ? cacheRead : input * ratio,
    cacheWrite: Number.isFinite(cacheWrite) && cacheWrite >= 0 ? cacheWrite : input,
    output: Number.isFinite(output) && output >= 0 ? output : 0,
  }
}

/**
 * Price one bucket set.
 * @param buckets - counts with at least the four usage fields.
 * @param card - resolved per-million card, or null.
 * @returns the cost, or null when unpriced.
 */
function costOf(buckets, card) {
  if (card === null) return null
  return (
    buckets.uncachedInput * card.input +
    buckets.cacheRead * card.cacheRead +
    buckets.cacheWrite * card.cacheWrite +
    buckets.output * card.output
  ) / 1_000_000
}

/**
 * Roll one bucket set up into a JSON-safe aggregate.
 * @param buckets - counts.
 * @param card - resolved per-million card, or null.
 * @returns the aggregate.
 */
function aggregate(buckets, card) {
  const billedInput = buckets.uncachedInput + buckets.cacheRead + buckets.cacheWrite
  return {
    uncachedInput: buckets.uncachedInput,
    cacheRead: buckets.cacheRead,
    cacheWrite: buckets.cacheWrite,
    output: buckets.output,
    billedInput,
    tokens: billedInput + buckets.output,
    calls: buckets.calls ?? 0,
    cacheHitRate: billedInput === 0 ? null : buckets.cacheRead / billedInput,
    cost: costOf(buckets, card),
  }
}

/**
 * Per-plugin fold cache. Each entry tracks whether its Session is live and how
 * far the log has been folded, so a request folds only the new tail.
 * @type {Map<string, { live: boolean, cursor: number, days: Map<string, object> }>}
 */
const folds = new Map()

/**
 * Current day buckets for one Session, folding only what has not been counted.
 * @param ctx - host context.
 * @param record - one listed Session record.
 * @returns the Session's day-bucket map.
 */
async function daysOf(ctx, record) {
  const id = String(record.header.id)
  const live = ctx.sessions.get(record.header.id)
  const entry = folds.get(id)

  if (live !== undefined && live !== null) {
    if (entry === undefined || !entry.live) {
      const fresh = { live: true, cursor: 0, days: new Map() }
      folds.set(id, fresh)
      const end = live.seq
      for (const event of live.snapshotEvents(0, end)) foldInto(fresh.days, event)
      fresh.cursor = end
      return fresh.days
    }
    const end = live.seq
    if (end > entry.cursor) {
      for (const event of live.snapshotEvents(entry.cursor, end)) foldInto(entry.days, event)
      entry.cursor = end
    }
    return entry.days
  }

  // Cold: a completed log cannot change, so fold it once and keep it.
  if (entry !== undefined && !entry.live) return entry.days
  const snapshot = await ctx.sessionQuery.readSession(record.header.id)
  const days = new Map()
  for (const event of snapshot.events) foldInto(days, event)
  folds.set(id, { live: false, cursor: snapshot.events.length, days })
  return days
}

/**
 * Accumulate one day map into running usage totals.
 * @param total - running usage bucket.
 * @param days - source day map.
 */
function addDays(total, days) {
  for (const bucket of days.values()) {
    total.uncachedInput += bucket.uncachedInput
    total.cacheRead += bucket.cacheRead
    total.cacheWrite += bucket.cacheWrite
    total.output += bucket.output
    total.calls += bucket.calls
  }
}

/**
 * Build the whole-profile usage summary.
 * @param ctx - host context.
 * @param config - the row's config: `currency`, `prices`, `cacheReadRatio`.
 * @returns the JSON-safe summary.
 */
async function summarize(ctx, config) {
  const records = await ctx.sessionQuery.listSessions()
  const today = dayKey(Date.now())
  const todayTotal = emptyUsage()
  const allTimeTotal = emptyUsage()
  const todayModels = new Map()

  for (const record of records) {
    let days
    try {
      days = await daysOf(ctx, record)
    } catch {
      continue // A migration-required or unreadable log contributes nothing.
    }
    addDays(allTimeTotal, days)
    const bucket = days.get(today)
    if (bucket === undefined) continue
    todayTotal.uncachedInput += bucket.uncachedInput
    todayTotal.cacheRead += bucket.cacheRead
    todayTotal.cacheWrite += bucket.cacheWrite
    todayTotal.output += bucket.output
    todayTotal.calls += bucket.calls
    for (const [model, usage] of bucket.models) {
      const running = todayModels.get(model) ?? { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
      running.uncachedInput += usage.uncachedInput
      running.cacheRead += usage.cacheRead
      running.cacheWrite += usage.cacheWrite
      running.output += usage.output
      todayModels.set(model, running)
    }
  }

  let todayCost = null
  const models = []
  for (const [model, usage] of todayModels) {
    const card = cardFor(config, model)
    const cost = costOf(usage, card)
    if (cost !== null) todayCost = (todayCost ?? 0) + cost
    models.push({ model, ...aggregate(usage, card) })
  }
  models.sort((left, right) => right.tokens - left.tokens)

  const todayAggregate = aggregate(todayTotal, null)
  todayAggregate.cost = todayCost

  const cards = {}
  for (const { model } of models) cards[model] = cardFor(config, model)

  return {
    generatedAt: Date.now(),
    currency: config?.currency ?? null,
    priced: models.some((entry) => entry.cost !== null),
    rates: cards,
    today: { date: today, ...todayAggregate },
    allTime: { sessions: records.length, ...aggregate(allTimeTotal, null) },
    models,
  }
}

/**
 * Activate the usage meter's HTTP face.
 * @param ctx - host context.
 * @param config - the row's config.
 */
export function apply(ctx, config) {
  const route = typeof config?.route === 'string' && config.route.startsWith('/')
    ? config.route
    : DEFAULT_ROUTE
  ctx.effect(() => {
    folds.clear()
    return () => folds.clear()
  }, 'dsh-usage-meter: fold cache')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: route,
    async handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.setHeader('Allow', 'GET, HEAD')
        res.end()
        return
      }
      try {
        const body = JSON.stringify(await summarize(ctx, config))
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(req.method === 'HEAD' ? undefined : body)
      } catch (error) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: String(error?.message ?? error) }))
      }
    },
  }), 'dsh-usage-meter: summary route')
}
