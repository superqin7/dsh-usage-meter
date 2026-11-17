/**
 * Host half of the usage meter.
 *
 * Folds every `assistant/message` usage record into buckets keyed by local day,
 * model, and peak/off-peak tariff, prices them with the configured rate table,
 * and serves the result as JSON on one exact route so the Client half can read
 * today's total and the model breakdown.
 *
 * Peak classification uses the Beijing-time schedule DeepSeek publishes
 * (Mon-Fri 09:00-12:00 and 14:00-18:00, excluding a configured holiday list),
 * evaluated in `Asia/Shanghai` regardless of the host machine's zone.
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

/** Peak windows in Beijing time, `[fromHour, toHour)`, Monday through Friday. */
const PEAK_WINDOWS = [[9, 12], [14, 18]]

/** The zone the published peak schedule is written in. */
const SCHEDULE_ZONE = 'Asia/Shanghai'

const zoneFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: SCHEDULE_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hour12: false,
  weekday: 'short',
})

/**
 * Break one instant into Beijing-time calendar parts.
 * @param time - epoch milliseconds.
 * @returns year, month, day, hour (0-23), and weekday index (0 = Sunday).
 */
function zoneParts(time) {
  const parts = zoneFormat.formatToParts(new Date(time))
  const read = (type) => parts.find((part) => part.type === type)?.value
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: Number(read('hour')),
    weekday: weekdays[read('weekday')] ?? 0,
  }
}

/**
 * Local-day key for one instant in the schedule zone.
 * @param time - epoch milliseconds.
 * @returns `YYYY-MM-DD`.
 */
function dayKey(time) {
  const { year, month, day } = zoneParts(time)
  return `${year}-${month}-${day}`
}

/**
 * Decide whether one instant falls in a peak tariff window.
 * @param time - epoch milliseconds.
 * @param holidays - set of `YYYY-MM-DD` holiday keys in the schedule zone.
 * @returns true when the published peak tariff applies.
 */
function isPeak(time, holidays) {
  const { year, month, day, hour, weekday } = zoneParts(time)
  if (weekday === 0 || weekday === 6) return false
  if (holidays.has(`${year}-${month}-${day}`)) return false
  return PEAK_WINDOWS.some(([from, to]) => hour >= from && hour < to)
}

/** Token buckets with no counts. */
function emptyUsage() {
  return { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }
}

/** One empty day bucket: peak and off-peak usage, counters, per-model split. */
function emptyDay() {
  return {
    peak: emptyUsage(),
    off: emptyUsage(),
    turns: 0,
    steps: 0,
    models: new Map(),
  }
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
 * @param holidays - holiday keys for peak classification.
 */
function foldInto(days, event, holidays) {
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
  const peak = isPeak(event.time, holidays)
  const key = dayKey(event.time)
  const bucket = days.get(key) ?? emptyDay()
  addUsage(peak ? bucket.peak : bucket.off, usage)
  let perModel = bucket.models.get(model)
  if (perModel === undefined) {
    perModel = { peak: emptyUsage(), off: emptyUsage() }
    bucket.models.set(model, perModel)
  }
  addUsage(peak ? perModel.peak : perModel.off, usage)
  days.set(key, bucket)
}

/**
 * Read an optional non-negative number.
 * @param value - candidate.
 * @returns the number, or null when absent or unusable.
 */
function optionalNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/**
 * Resolve the rate card for one model, in the display currency.
 *
 * A card declares peak rates plus the multiplier applied off-peak, so a
 * provider with a flat tariff simply omits `offPeakRatio` and gets 1.
 * @param config - the row's config.
 * @param model - model id from the event.
 * @returns the resolved card, or null when the model is unpriced.
 */
function cardFor(config, model) {
  const raw = config?.prices?.[model] ?? config?.defaultPrice
  if (raw === undefined || raw === null) return null
  const input = optionalNumber(raw.input)
  if (input === null) return null
  const fallbackRatio = optionalNumber(config?.cacheReadRatio) ?? 0.1
  const cacheRead = optionalNumber(raw.cacheRead)
  const cacheWrite = optionalNumber(raw.cacheWrite)
  return {
    peak: {
      uncachedInput: input,
      cacheRead: cacheRead ?? input * fallbackRatio,
      cacheWrite: cacheWrite ?? input,
      output: optionalNumber(raw.output) ?? 0,
    },
    offPeakRatio: optionalNumber(raw.offPeakRatio) ?? 1,
  }
}

/**
 * Price a peak/off-peak usage pair.
 * @param buckets - `{ peak, off }` usage buckets.
 * @param card - resolved card, or null.
 * @returns the cost, or null when unpriced.
 */
function costOf(buckets, card) {
  if (card === null) return null
  const rates = card.peak
  const pricedPeak =
    buckets.peak.uncachedInput * rates.uncachedInput +
    buckets.peak.cacheRead * rates.cacheRead +
    buckets.peak.cacheWrite * rates.cacheWrite +
    buckets.peak.output * rates.output
  const pricedOff =
    buckets.off.uncachedInput * rates.uncachedInput +
    buckets.off.cacheRead * rates.cacheRead +
    buckets.off.cacheWrite * rates.cacheWrite +
    buckets.off.output * rates.output
  return (pricedPeak + pricedOff * card.offPeakRatio) / 1_000_000
}

/**
 * Sum a peak/off-peak pair into one combined usage bucket.
 * @param buckets - `{ peak, off }`.
 * @returns one usage bucket.
 */
function combined(buckets) {
  const total = emptyUsage()
  for (const part of [buckets.peak, buckets.off]) {
    total.uncachedInput += part.uncachedInput
    total.cacheRead += part.cacheRead
    total.cacheWrite += part.cacheWrite
    total.output += part.output
    total.calls += part.calls
  }
  return total
}

/**
 * Roll a peak/off-peak pair up into a JSON-safe aggregate.
 * @param buckets - `{ peak, off }`.
 * @param card - resolved card, or null.
 * @returns the aggregate.
 */
function aggregate(buckets, card) {
  const total = combined(buckets)
  const billedInput = total.uncachedInput + total.cacheRead + total.cacheWrite
  return {
    uncachedInput: total.uncachedInput,
    cacheRead: total.cacheRead,
    cacheWrite: total.cacheWrite,
    output: total.output,
    billedInput,
    tokens: billedInput + total.output,
    calls: total.calls,
    peakTokens: buckets.peak.uncachedInput + buckets.peak.cacheRead + buckets.peak.cacheWrite + buckets.peak.output,
    offPeakTokens: buckets.off.uncachedInput + buckets.off.cacheRead + buckets.off.cacheWrite + buckets.off.output,
    cacheHitRate: billedInput === 0 ? null : total.cacheRead / billedInput,
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
 * @param holidays - holiday keys for peak classification.
 * @returns the Session's day-bucket map.
 */
async function daysOf(ctx, record, holidays) {
  const id = String(record.header.id)
  const live = ctx.sessions.get(record.header.id)
  const entry = folds.get(id)

  if (live !== undefined && live !== null) {
    if (entry === undefined || !entry.live) {
      const fresh = { live: true, cursor: 0, days: new Map() }
      folds.set(id, fresh)
      const end = live.seq
      for (const event of live.snapshotEvents(0, end)) foldInto(fresh.days, event, holidays)
      fresh.cursor = end
      return fresh.days
    }
    const end = live.seq
    if (end > entry.cursor) {
      for (const event of live.snapshotEvents(entry.cursor, end)) foldInto(entry.days, event, holidays)
      entry.cursor = end
    }
    return entry.days
  }

  // Cold: a completed log cannot change, so fold it once and keep it.
  if (entry !== undefined && !entry.live) return entry.days
  const snapshot = await ctx.sessionQuery.readSession(record.header.id)
  const days = new Map()
  for (const event of snapshot.events) foldInto(days, event, holidays)
  folds.set(id, { live: false, cursor: snapshot.events.length, days })
  return days
}

/**
 * Accumulate one day map into running peak/off-peak totals.
 * @param target - `{ peak, off }` bucket pair.
 * @param days - source day map.
 */
function addDays(target, days) {
  for (const bucket of days.values()) {
    for (const side of ['peak', 'off']) {
      target[side].uncachedInput += bucket[side].uncachedInput
      target[side].cacheRead += bucket[side].cacheRead
      target[side].cacheWrite += bucket[side].cacheWrite
      target[side].output += bucket[side].output
      target[side].calls += bucket[side].calls
    }
  }
}

/**
 * Build the whole-profile usage summary.
 * @param ctx - host context.
 * @param config - the row's config: `currency`, `prices`, `cacheReadRatio`, `holidays`.
 * @returns the JSON-safe summary.
 */
async function summarize(ctx, config) {
  const records = await ctx.sessionQuery.listSessions()
  const today = dayKey(Date.now())
  const holidays = new Set(Array.isArray(config?.holidays) ? config.holidays : [])
  const todayTotal = { peak: emptyUsage(), off: emptyUsage() }
  const allTimeTotal = { peak: emptyUsage(), off: emptyUsage() }
  const todayModels = new Map()

  for (const record of records) {
    let days
    try {
      days = await daysOf(ctx, record, holidays)
    } catch {
      continue // A migration-required or unreadable log contributes nothing.
    }
    addDays(allTimeTotal, days)
    const bucket = days.get(today)
    if (bucket === undefined) continue
    for (const side of ['peak', 'off']) {
      todayTotal[side].uncachedInput += bucket[side].uncachedInput
      todayTotal[side].cacheRead += bucket[side].cacheRead
      todayTotal[side].cacheWrite += bucket[side].cacheWrite
      todayTotal[side].output += bucket[side].output
      todayTotal[side].calls += bucket[side].calls
    }
    for (const [model, usage] of bucket.models) {
      let running = todayModels.get(model)
      if (running === undefined) {
        running = { peak: emptyUsage(), off: emptyUsage() }
        todayModels.set(model, running)
      }
      for (const side of ['peak', 'off']) {
        running[side].uncachedInput += usage[side].uncachedInput
        running[side].cacheRead += usage[side].cacheRead
        running[side].cacheWrite += usage[side].cacheWrite
        running[side].output += usage[side].output
        running[side].calls += usage[side].calls
      }
    }
  }

  let todayCost = null
  const models = []
  const rates = {}
  for (const [model, usage] of todayModels) {
    const card = cardFor(config, model)
    const cost = costOf(usage, card)
    if (cost !== null) todayCost = (todayCost ?? 0) + cost
    rates[model] = card === null ? null : { ...card.peak, offPeakRatio: card.offPeakRatio }
    models.push({ model, ...aggregate(usage, card) })
  }
  models.sort((left, right) => right.tokens - left.tokens)

  const todayAggregate = aggregate(todayTotal, null)
  todayAggregate.cost = todayCost

  return {
    generatedAt: Date.now(),
    currency: config?.currency ?? null,
    priced: models.some((entry) => entry.cost !== null),
    schedule: { zone: SCHEDULE_ZONE, peakWindows: PEAK_WINDOWS, holidays: [...holidays] },
    rates,
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
