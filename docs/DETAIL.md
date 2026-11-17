# Token 用量统计 / Token usage meter

**简体中文** | [English](#english)

---

## 简体中文

回答一个问题：今天这个 Harness 花了多少 token，大概多少钱。

### 显示在哪

- **侧边栏底部** —— 一个翻页计数器：`今日消耗token：79,825,490`。侧边栏收起成 56px 窄轨时只留图标。只有变化的那几位数字会翻，个位先翻、往左错峰。
- **点一下** —— 在侧边栏底部上方展开面板：
  - 今日 token（翻页大字）
  - 预估花费
  - 缓存命中率 / 输入 / 输出 / 缓存命中数
  - 按模型（今日）一行一个：模型名、token 数、花费

对话流里不渲染任何东西。

### 数字从哪来

Host 端把每条带 `usage` 的 `assistant/message` 事件折叠进「本地日 × 模型 × 峰谷」分桶。四个桶互不重叠：未命中输入、缓存命中读、缓存写入、输出。

活跃会话增量折叠，只读新增的日志尾巴；已结束的会话读一次就缓存，因为完成的日志在它重新变活之前不会变。

汇总挂在 `GET /plugin/usage-meter/summary` 上，Client 每 4 秒轮询。

### 费用

费用来自插件配置里的费率表，单位是**每百万 token**，`input` 指缓存未命中的输入价：

```yaml
- id: usage-meter
  name: dsh-usage-meter
  config:
    currency: CNY
    holidays: [2026-10-01]
    prices:
      deepseek-flash: { input: 2, cacheRead: 0.04, output: 8, offPeakRatio: 0.5 }
      qwen3.8-flash: { input: 0.8, cacheRead: 0.1, output: 2.7 }
    defaultPrice: { input: 2, cacheRead: 0.04, output: 8, offPeakRatio: 0.5 }
```

模型没写 `cacheRead` 时，按 `cacheReadRatio` × 输入价兜底。

**峰谷计价**：模型一旦写了 `offPeakRatio`，每条用量按**它自己的时间戳**判断峰谷，跨边界的会话也能正确拆分。内置时段与 DeepSeek 一致：`Asia/Shanghai`，周一至周五 09:00-12:00、14:00-18:00 为高峰；周末全天空闲。

内置的 `holidays` 已包含中国大陆 2026、2027 年法定节假日（2027 为预排）。调休补班日不列入，因为官方规则只把周一至周五定义为高峰。

### 限制

- **金额是估算，不是账单。** 不读发票，也不读账户余额。
- **每个模型只有一张卡片。** 按长度分档（MiniMax-M3 超 512K）、批量折扣、优先档，一律按标准刊例价算。
- **不算非 token 成本。** 图片输出、搜索调用、文件解析、存储都不在此列。
- **路由只响应本机（回环）调用**，除非设 `allowRemote: true`。可读 token 总量、会话数和有用量会话的工作目录 —— 读不到对话内容。
- **历史跟着日志走。** 不建数据库；删掉会话数据，统计随之消失。

---

## English

Answers one question: how many tokens has this Harness spent today, and roughly what did they cost.

### Where it shows up

- **Sidebar foot** — a split-flap counter: `Today: 79,825,490`. In the collapsed 56px rail only the glyph remains. Only the digit positions that changed flip, rightmost first.
- **Click it** — a panel opens above the sidebar foot with today's tokens as flip digits, the estimated cost, cache hit rate, input, output, cache reads, and one row per model used today.

Nothing is rendered in the conversation flow.

### Where the numbers come from

The Host folds every `assistant/message` event that carries `usage` into buckets keyed by local day, model, and peak/off-peak tariff. The four buckets are disjoint: uncached input, cache read, cache write, and output.

Live sessions are folded incrementally — only the new tail is read per request. A cold session is read once and cached, because a finished log cannot change until that session becomes live again.

The summary is served on `GET /plugin/usage-meter/summary`, and the Client polls it every four seconds.

### Cost

Cost comes from the rate table in the plugin config, in currency units **per one million tokens**, with `input` meaning the cache-miss rate. A model that omits `cacheRead` falls back to `cacheReadRatio` × its input rate.

**Peak and off-peak**: when a model sets `offPeakRatio`, every usage record is classified by its own timestamp, so a session spanning a boundary is split correctly. The shipped schedule matches DeepSeek's: `Asia/Shanghai`, Monday to Friday, 09:00-12:00 and 14:00-18:00 are peak; weekends are off-peak all day.

The shipped `holidays` list covers mainland China's 2026 and 2027 public holidays (2027 is provisional). Adjusted make-up workdays are excluded, because the published rule only names Monday to Friday as peak.

### Limitations

- **The cost is an estimate, not a bill.** It reads no invoice and no account balance.
- **One card per model.** Length-tiered pricing, batch discounts, and priority tiers are all priced at the standard listed rate.
- **No non-token cost.** Image output, search calls, file parsing, and storage are invisible here.
- **The route answers loopback callers only** unless `allowRemote: true`. It exposes token totals, session counts, and the working directories of sessions with usage — not conversation content.
- **History follows the logs.** No database; delete session data and the totals drop with it.
