# dsh-usage-meter

[English](README.md) | **简体中文**

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的 token 用量与花费计量插件。

侧边栏底部是一个翻页计数器，显示**今天**消耗了多少 token。点一下展开面板，可以看到预估花费、缓存命中情况，以及按模型的明细。

所有数字都来自 Harness 本来就在写的会话日志。插件不读发票、不要账号凭据、不外发任何数据。

## 显示什么

**侧边栏底部** —— `图标 · 今日消耗token：79,825,490`。侧边栏收起成 56px 窄轨时只保留图标。数字像老式日历翻牌：**只有变化的那几位会翻**，个位先翻、往左错峰。

**点开的面板**：

| | |
|---|---|
| 今日消耗 token | 翻页大字 |
| 预估花费 | 同字号，强调色 |
| 缓存命中率 | 缓存命中 / 全部输入 |
| 输入 | 全部输入（未命中 + 命中 + 缓存写入） |
| 输出 | 输出 token |
| 缓存命中数 | 走缓存的输入 token |
| 按模型（今日） | 每行：模型名 · token 数 · 花费 |

回车（Esc）关闭；面板头部有刷新和关闭按钮。

## 安装

需要 DeepSeek Harness 0.2.x，并且指定要装进哪个 profile。

```sh
# Web 版
dsh plugin --profile web add github:superqin7/dsh-usage-meter

# 桌面版（Desktop 用自带 CLI 和 desktop profile）
dsh plugin --profile desktop add github:superqin7/dsh-usage-meter
```

固定版本安装：

```sh
dsh plugin --profile web add github:superqin7/dsh-usage-meter#v1.1.1
```

本地目录也可以：

```sh
dsh plugin --profile web add /绝对路径/dsh-usage-meter
```

安装或更新后需要**重启 `dsh web`**（桌面版重启应用）。Client 部分的改动还需要**刷新一次页面**才会生效。

## 配置价格

配置在包旁边的 `cordis.patch.yml` 里。费率单位是「**每百万 token**」，`input` 指**缓存未命中**的输入价。

```yaml
- id: usage-meter
  name: dsh-usage-meter
  config:
    route: /plugin/usage-meter/summary
    currency: CNY
    cacheReadRatio: 0.1   # 卡片没写 cacheRead 时的兜底比例
    holidays: []          # Asia/Shanghai 时区下按空闲计价的日期
    prices:
      deepseek-flash:
        input: 2          # 缓存未命中输入（高峰价）
        cacheRead: 0.04   # 缓存命中输入（高峰价）
        output: 8         # 输出（高峰价）
        offPeakRatio: 0.5 # 空闲时段倍率；平价计费就不写
      qwen3.8-flash:
        input: 0.8
        cacheRead: 0.1
        output: 2.7
    defaultPrice: { input: 2, cacheRead: 0.04, output: 8, offPeakRatio: 0.5 }
```

| 配置项 | 含义 |
|---|---|
| `route` | 返回 JSON 的精确 HTTP 路径 |
| `currency` | 显示符号：`CNY`、`USD`、`EUR`，其它值不带符号 |
| `prices` | 每个模型的 `input` / `output`，可选 `cacheRead` / `cacheWrite` |
| `prices.*.offPeakRatio` | 空闲时段对所有费率的倍率，默认 `1`（平价） |
| `cacheReadRatio` | 模型没写 `cacheRead` 时，按输入价乘以这个比例 |
| `holidays` | `YYYY-MM-DD` 列表，这些日期全天按空闲计价 |
| `allowRemote` | 是否响应非回环调用，默认 `false` |
| `unpricedModels` | 只报 token、不报花费的模型（不套用兜底价） |
| `defaultPrice` | 表里没有的模型的兜底卡片 |

### 峰谷计价

有的厂商按时段定价。模型一旦写了 `offPeakRatio`，每条用量就按**它自己的时间戳**判断峰谷，而不是按请求时刻 —— 跨过边界的会话也能正确拆分。

内置的时段表与 DeepSeek 一致：**Asia/Shanghai，周一至周五 09:00-12:00、14:00-18:00** 为高峰；周末全天空闲；`holidays` 里的日期也全天空闲。没写 `offPeakRatio` 的模型完全不看时段表。

内置的 `holidays` 已包含中国大陆 **2026 和 2027 年**的法定节假日。2027 年的日期是**预排**（国务院通常在当年 11 月才发布次年安排），正式通知出来后更新该列表即可。调休补班日**故意不列入**，因为官方规则只把周一至周五定义为高峰。

### 两个容易踩的坑

- **缓存命中价决定一切。** 长会话里 95% 以上的 prompt token 是缓存命中，而缓存命中价可能只有输入价的 1/50。`cacheRead` 错 5 倍，比表里其它任何一项错误影响都大。
- **模型 id 必须完全一致。** id 来自 `assistant/message` 事件里的模型身份，也就是 provider 适配器上报的名字，通常与模型选择器里显示的一致。

### 内置费率（2026-11-17 核对）

以下是各厂商**公开刊例价**，单位为「元（CNY）/ 每百万 token」。仓库直接内置，装上就有真实花费，无需额外配置。

| 模型 | 输入(未命中) | 缓存命中 | 输出 | 计费方式 |
|---|---|---|---|---|
| `deepseek-flash` | ¥2 | ¥0.04 | ¥8 | 峰谷 0.5× |
| `deepseek-v4-pro` | ¥9 | ¥0.30 | ¥27 | 峰谷 0.5× |
| `qwen3.8-flash` | ¥0.8 | ¥0.1 | ¥2.7 | 平价 |
| `qwen3.8-27b` | ¥3 | ¥0.6 | ¥12 | 平价 |
| `qwen3.8-max` | ¥12 | ¥1.5 | ¥36 | 平价 |
| `glm-5.3-flash` | ¥0.8 | ¥0.23 | ¥2.8 | 平价 |
| `glm-5.3` | ¥8 | ¥2 | ¥28 | 平价 |
| `kimi-k3` | ¥20 | ¥2 | ¥100 | 平价 |
| `MiniMax-M3` | ¥2.1 | ¥0.42 | ¥8.4 | 平价（见下） |
| `MiniMax-H3-Image-PE` | ¥15 | — | — | 仅输入 |

来源：

- DeepSeek — <https://api-docs.deepseek.com/zh-cn/quick_start/pricing>
- 阿里云百炼（华北2 北京）— `help.aliyun.com/zh/model-studio/qwen3-8-{flash,max,27b}`
- 智谱 — <https://docs.bigmodel.cn/cn/guide/start/pricing>
- Moonshot — <https://platform.kimi.com/docs/pricing/chat>
- MiniMax — <https://platform.minimax.cn/docs/pricing/overview>

关于上表的四点说明：

- **MiniMax-M3 是按输入长度分档的，不是平价。** 输入超过 512K token 价格翻倍（¥4.2 / ¥0.84 / ¥16.8）。插件对每次调用都按 ≤512K 档计价，所以超长 prompt 的会话会被低估。该数字同时是当前**五折促销价**。
- **`MiniMax-H3-Image-PE` 不是公开型号 id。** 它对应的是 MiniMax 的 `H3-Image-Context-IR`（Prompt 增强）计费：只收输入、不单独收输出、没有缓存档。
- **自建部署的模型没有公开价。** `nvidia/Qwen3.6-35B-A3B-NVFP4` 和 `Qwen/Qwen3.8-27B-FP8` 是私有部署，已列入 `unpricedModels`：面板上它们**只显示 token、金额标记为「自建 · 未定价」**，不会套用兜底价去编一个数字。
- **`kimi-k3` 的缓存写入单独计价**（5 分钟 ¥20、1 小时 ¥40）。卡片用的是输入价，对应 5 分钟档。

## 数字是怎么算出来的

Host 端把每条带 `usage` 的 `assistant/message` 事件折叠进「**本地日 × 模型 × 峰谷**」三维分桶：

```
uncachedInput += usage.inputTokens
cacheRead     += usage.cacheReadTokens
cacheWrite    += usage.cacheWriteTokens
output        += usage.outputTokens
```

活跃会话是**增量折叠**的：每次请求只读日志新增的尾巴。已结束的会话通过 `sessionQuery.readSession` 读一次就缓存，因为完成的日志在它重新变活之前不会变。

汇总结果以 JSON 形式挂在配置的路由上，Client 端每 4 秒轮询一次。

费用按桶分别计算再合并：

```
peak = uncachedInput_p × input + cacheRead_p × cacheRead + cacheWrite_p × cacheWrite + output_p × output
off  = uncachedInput_o × input + cacheRead_o × cacheRead + cacheWrite_o × cacheWrite + output_o × output
cost = (peak + off × offPeakRatio) / 1e6
```

## 出问题了怎么查

1. **侧边栏显示 `—`**：说明 Client 拿不到数据。找到当前 web 端口（`dsh web` 启动时会打印，也可以在设置里看到），直接请求一下路由：

   ```sh
   curl http://127.0.0.1:<端口>/plugin/usage-meter/summary
   ```

   返回 200 和 JSON 就是正常的；返回 500 会带 `{"error": "..."}` 说明原因。

2. **面板里所有金额都是 `—`**：该模型的 id 不在 `prices` 里，也没有 `defaultPrice`。看一眼 JSON 里 `models[].model` 的真实 id，照抄进配置。

3. **改了价格没生效**：价格是每次请求实时应用的，理论上立刻生效；但如果改的是 `holidays`，需要重新加载插件（它会重建峰谷分桶）。

4. **金额明显偏高**：先检查 `cacheRead`。缓存命中占绝大多数 token，这一项错了会直接主导总额。

## 已知限制

- **金额是估算。** 它不读任何厂商发票或账户余额，也无法与之对账。
- **每个模型只有一张卡片。** 按长度分档（MiniMax-M3 超过 512K 输入）、批量折扣、优先档，一律按标准刊例价计算。
- **不算非 token 成本。** 图片输出、搜索调用、文件解析、存储、按次计费都不在此列。
- **路由只响应本机（回环）调用**，除非设 `allowRemote: true`。它能读到 token 总量、会话数量和有用量会话的工作目录 —— 但**读不到对话内容**。
- **历史跟着日志走。** 插件不建数据库；删掉会话数据，统计也随之消失。

## 开发

纯 ESM，无构建步骤、无依赖。`index.js` 是 Host 端，`client.js` 是浏览器模块，`cordis.patch.yml` 是加载器补丁。

```
index.js            Host：折叠、计价、HTTP 路由
client.js           Client：侧边栏入口、面板、翻页数字
cordis.patch.yml    加载器条目与默认费率表
locale/{en,zh}.json 插件管理器卡片文案
docs/DETAIL.md      插件详情页
```

## 许可证

MIT
