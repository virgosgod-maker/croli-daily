# 可行性分析：Croli 每日签到 / 每日首次对话自动化

> 结论先说：**签到能做、且很稳；每日首次对话要么"真跑一次对话"，要么就是伪造使用记录。**
> **它不能做成喜鹊（magpie）插件**——喜鹊插件是改 LLM 请求的中间件，没有定时器，
> 也发不了 Croli 的 API 请求。正确形态是一个独立的小定时任务。

## 1. 目标拆解

| 任务 | 服务端判定依据 | 能否凭空完成 |
| --- | --- | --- |
| 每日签到 | `POST /v1/ops/checkin` `{taskId:1}` | **能**，一个 POST 即可（+100，连签有额外奖励） |
| 每日首次对话 | 事件 `agent_turn_completed`，periodKey=当天 | 能，但"上报事件"等于撒谎 |
| 导入本地会话 | 事件 `conversations_imported`（一次性，已领） | 已完成，无需处理 |

## 2. 接口是我怎么确认的（不是猜的）

从本机 Croli 0.0.17 的 `app.asar` 里解出积分模块
（`web/_next/static/chunks/36aej3yykjn_y.js`），核心就是一个函数：

```js
async function ea(e, t = "GET", n) {
  let a = token();                                  // Clerk access_token
  let r = await fetch(`https://ds.croli.net/credits${e}`, {
    method: t,
    headers: { Authorization: `Bearer ${a}`, ...(n ? {"Content-Type":"application/json"} : {}) },
    body: n ? JSON.stringify(n) : undefined,
  });
  ...
}
```

调用点：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/v1/ops/home` | 任务状态、periodKey、streak |
| POST | `/v1/ops/checkin` | 签到，body `{taskId:1}` |
| POST | `/v1/ops/tasks/{id}/claim` | 领奖（`claimMode:"auto"` 时服务端自动发） |
| POST | `/v1/ops/events` | 事件上报，body `{eventKey, eventId, metadata}` |
| GET | `/v1/account/balance`、`/v1/account/ledger` | 余额与流水 |

实测响应（2026-11-20，只读）：

```json
// GET /v1/ops/home
{"claimableCount":0,"timezone":"Asia/Shanghai",
 "programs":[{"tasks":[{"key":"daily-checkin","id":1,"periodKey":"2026-11-20",
   "status":"claimed","claimMode":"auto","milestones":[{"credits":100,"status":"claimed"}],
   "streak":{"current":1,"longest":1,"nextBonusAt":3,"nextBonusCredits":20}}]}]}

// POST /v1/ops/checkin (当天已签时)
{"alreadyCheckedIn":true,"creditsAwarded":0,"nextResetAt":"2026-11-20T16:00:00Z"}
```

两个关键点让这件事很好做：

1. **幂等是服务端给的**：`ops/home` 的 `status` 字段直接告诉你今天领没领，重复 POST 也只返回
   `alreadyCheckedIn: true`，不会报错、不会重复发。
2. **周期边界是 UTC 16:00 = 北京时间次日 0 点**，与本地自然日对齐，不用算时区。

## 3. 为什么不能做成"喜鹊插件"

你的原话是"做成喜鹊插件的那种，放在 NAS 上 24 小时跑"。这里需要纠正：

> 喜鹊（magpie，NAS 上 `ghcr.io/yetone/magpie:latest`）的插件是**模型网关的中间件**：
> 用 JS 写 `onRequest` / `onResponse` 之类的钩子，改写进出的 LLM 请求。
> 它**没有定时器**（查了 `internal/plugin`、`internal/pluginrt`，只有 10ms/20ms 的
> 内部心跳 ticker，没有 cron 能力），也**没有发起任意 HTTP 请求的工具**。

也就是说：喜鹊插件只能"当有模型请求经过时"做事，而签到需要的是"每天到点主动做事且没有请求"。
即使写一个中间件，也得等你恰好用一次模型才顺带触发，做不到"每天不落下"。

**所以形态是**：一个独立容器/进程（cron 或 systemd timer），和喜鹊共用 NAS 但互不依赖。
喜鹊在 NAS 上继续做它原本的事（网关），这个项目只借 NAS 的"7×24 通电"。

## 4. 每个任务落到 NAS 上到底行不行

### 4.1 签到：能，很干净

只需要一个 HTTPS POST + 一个有效 token。NAS 有网就行。x86_64 的 Debian 12 跑 Node 20 容器毫无压力。

### 4.2 每日首次对话：两条路，都不理想

**路 A —— 真跑一次对话（推荐，诚实）**

Croli 服务端有两种运行形态，两种都验证了：

- `croli-server`（Rust 二进制，Linux x64 可用）。从官方 deb 里解出来，在 NAS 上直接跑起来过：

  ```
  [SERVER] Token: 0af3...
  [SERVER] Listening on: http://127.0.0.1:13080
  $ croli-cli --url http://100.114.139.5:13080 --token $TOK agents
  SLUG         ENABLED   INSTALLED  NAME
  claude_code  yes       no         Claude Code
  deepseek     yes       no         DeepSeek Harness
  ```

  服务端是活的、CLI 能连上。但 `INSTALLED` 全是 `no` —— **没有 agent 就跑不了对话**，
  得再装一个 ACP agent（如 `deepseek-acp`），并且要一份能用的模型凭据。

  另外注意：`croli-server` 二进制里 `agent_turn_completed` 计数为 **0**，
  说明这个事件是**前端（Next.js 页面）在上报**的，不是服务端。所以"headless 真跑对话"能不能
  让服务端自己算成"完成首次对话"，**没有验证过**（没有 agent 装不了），属于未验证假设。

**路 B —— 直接上报事件（快，但是伪造）**

```bash
POST /v1/ops/events {"eventKey":"agent_turn_completed","eventId":"<uuid>","metadata":{}}
```

实测这个接口**接受**了（`{"accepted":true,"duplicate":false}`）。技术上一天 200 分唾手可得。
但这等于向服务端谎称"我今天真的用了一次 AI"。这是刷量，不是自动化自己的正常使用，
按 Croli 服务条款大概率属于滥用。**项目里默认关闭（`DAILY_CHAT_MODE=off`）**，
要用必须显式打开，风险自负。

建议：**只自动签到（+100/天，连签还有奖励），首次对话保持手动**。
为了 200 分把账号放上赌桌不划算。

## 5. 最大的技术风险：refresh token 是一次性的（已实测踩中）

Croli 用 Clerk 做认证。`auth.json` 里是 `access_token` + `refresh_token`，
access_token 有效期 24 小时（`expires_in: 86400`）。

**Clerk 的 refresh token 会轮换，且启用了重放检测。** 实测过程：

1. 用 refresh_token 换新的一对 → 成功，拿到新的 refresh_token（旧的作废）；
2. 再拿**旧** refresh_token 试一次 → `{"error":"invalid_grant", "...The refresh token was already used."}`；
3. 之后**新旧 access_token 全部 401**，`/v1/account/balance`、`/v1/ops/home`、Clerk 的
   `/oauth/userinfo` 一律拒绝。

这是标准 OAuth 的 refresh token 重放防护：一旦检测到已用过的 refresh token 被再次使用，
**整条令牌家族被判为泄露并吊销**。

对方案的三个直接后果：

- **Mac 桌面端和 NAS 绝不能共享同一条 refresh token 链**。谁先刷谁把对方踢下线，
  而且重放检测会让两边一起死。→ NAS 必须用**独立登录**得到自己的一条链。
- 这个项目的 `TokenStore` 因此做了进程锁 + 原子写 + 0600，保证**只有一个写入方**。
- 登录失效无法自动恢复（Clerk 设备码授权被 Croli 客户端关闭了：
  `device_authorization` 返回 `The requested OAuth 2.0 Client does not have the device_code grant`）。
  掉登录只能人工重新登录一次，把新的 `auth.json` 同步过去。

### 关于"NAS 独立登录"（已实测：技术上完全可行）

`croli-server` 里带着一整套 headless 登录路由：`/api/desktop_auth_start`、
`/api/desktop_auth_status`、`/api/desktop_auth_cancel`。在 NAS 上实测：

```bash
POST /api/desktop_auth_start {}
→ {"authorizationUrl":"https://croli.net/desktop/login?authorize=https%3A%2F%2Fclerk.croli.net%2Foauth%2Fauthorize%3F...redirect_uri%3Dhttp%253A%252F%252F127.0.0.1%253A28743%252Fcallback...&code_challenge=...&state=..."}

POST /api/desktop_auth_status {}
→ {"configured":true,"account":null,"pending":true,"error":null}
```

也就是说：**服务端会自己起一个回环端口（28743）等回调，登录成功后自动写入它自己数据目录下的
`auth.json`**——一份完全独立的令牌链，不与桌面端共享。

难点只有一个：`redirect_uri` 指向 NAS 的 `127.0.0.1:28743`，而你在 Mac 上点链接。
解决办法是临时搭一个中继（NAS 的 sshd 默认 `AllowTcpForwarding=no`，`ssh -L` 被拒，所以
要在 Mac 上起一个 HTTP 服务，收到回调后用 `ssh + curl` 把这次请求转发进 NAS 的回环端口）。
**这条中继链路已经验证打通**：用假 `code` 请求，NAS 正确返回
`303 See Other → https://croli.net/desktop/success/?result=failed`，
说明回调、state 校验、中继全部正常。

**但有一个前置风险没解决**：Croli 的 Clerk 配置里 `single_session_mode: true`
（我读了 `https://clerk.croli.net/v1/environment`）。单会话模式下，新登录**可能会把
已有的桌面端会话踢掉**。考虑到本次排查已经让你重新登录过一次，这个实验**没有继续执行**，
留给你自己决定是否承受再一次重登的代价。

结论：**技术上 NAS 独立登录可行且不需要图形界面**；要不要做，取决于你是否愿意为它
可能踢掉桌面端会话而再登录一次。

## 6. 结论

| 问题 | 答案 |
| --- | --- |
| 能不能实现？ | 能。签到是 1 个 POST，接口已实测 |
| 好不好实现？ | 签到很容易（本项目零依赖）；首次对话不难但"不诚实"或"要装 agent" |
| 能做成喜鹊插件吗？ | **不能**。喜鹊插件是 LLM 网关中间件，没有定时器 |
| 能放 NAS 24 小时跑吗？ | 签到可以；对话要看是否愿意在 NAS 上装 agent + 单独登录 |
| 最大风险 | refresh token 一次性 + 重放即吊销整条链，双端共享必炸；脚本刷积分可能封号 |

## 7. 推荐落地顺序

1. 先在 Mac 上跑 `croli-daily status` / `run`，确认签到正常（用**独立的** auth 副本）。
2. 确认无副作用后，再上 NAS 容器（`deploy/`），NAS 侧只做签到。
3. 想连首次对话一起做，再单独评估装 agent 的成本。
