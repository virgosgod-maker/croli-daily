# croli-daily

Croli 每日任务的常驻自动化：**自动签到 + 每日首次对话 + 网页看积分**。

零第三方依赖（Node 20+ 内置 fetch）。一个容器，一个网页，一个凭据文件。

## 它给你什么

| 你要的 | 实现 |
| --- | --- |
| 全自动挂着 | 容器常驻，每天 0:10 后自动执行，每 10 分钟校验，漏了就补跑 |
| 每日签到 | `POST /v1/ops/checkin`，+100 积分，连签有额外奖励 |
| 每日首次对话 | 用 `croli-cli` 真跑一次对话（需 NAS 上有 agent，见下） |
| 在别处看积分 | `http://<nas>:8787/` 网页，手机可开，每 60 秒刷新；也有 `/api/status` JSON |

## 快速开始（Mac 上先验证）

```bash
cp .env.example .env
$EDITOR .env                 # 设 CROLI_AUTH_FILE

node src/cli.mjs status      # 只读：任务状态 + 余额
node src/cli.mjs run         # 执行今日任务（幂等）
node src/cli.mjs serve       # 常驻：定时执行 + 开面板 http://localhost:8787/
node --test test/            # 10 项测试
```

## 在喜鹊（magpie）里看积分

`magpie-plugin/` 是一个真正的喜鹊插件：用 `auth.usage` 把**总积分 / 今日免费额度 /
剩余重置次数**画进喜鹊的 Usage 卡片，用 `auth.checkin` 每天自动签到。

插件在独立仓库：**https://github.com/virgosgod-maker/magpie-croli**

```bash
magpie plugin add github:virgosgod-maker/magpie-croli
```

## 部署到 NAS

见 [docs/deploy-nas.md](docs/deploy-nas.md)。已验证：镜像能 build、容器能读真实数据、
面板能出积分、容器以 mango(1000:10) 身份运行不需 sudo。

三行：

```bash
cd /volume1/docker/croli-daily
cp deploy/docker-compose.yml .
docker compose up -d
```

然后手机打开 `http://192.168.3.8:8787/` 或 `http://100.114.139.5:8787/`（Tailscale）。

## 每日首次对话：需要额外一步

签到全自动没问题。首次对话要求**真的跑一次对话**，所以 NAS 上得有：

1. `croli-server`（官方 deb 里有 Linux x64 版，已实测能在 NAS 跑起来）
2. 一个 ACP agent（如 `deepseek-acp`）+ 模型凭据
3. 然后 `DAILY_CHAT_MODE=real` + `CROLI_CLI` 指向可执行文件

**这一步未完整验证**（NAS 上还没有 agent）。在你决定之前，签到照常全自动。

## 在 NAS 上真跑对话（首次对话自动化）

`Dockerfile.agent` + `deploy/docker-compose.agent.yml` 能把 `croli-server`、
`croli-cli`、`deepseek-acp` 一起跑起来，让服务端**自己**判定今天有过对话。

链路已实测打通，但当前卡在账号侧：模型 key 的 $50 总额度用尽
（`Key limit exceeded ... $50.01 of $50.00 used`），**Mac 桌面端报同样的错**。
详见 [docs/agent-on-nas.md](docs/agent-on-nas.md)。

## 刻意不做的事

**不提供伪造首次对话。** 直接 `POST /v1/ops/events` 上报 `agent_turn_completed`
技术上能拿到 200 分（实测接口接受），但那等于向服务端谎称"今天用过 AI"，
属于刷量，有封号风险。代码里 `DAILY_CHAT_MODE=event` 会直接报错拒绝。

## 最重要的坑：refresh token 是一次性的

Clerk 的 refresh token 轮换且带重放检测。一旦用旧的 refresh token 重试，
**整条令牌链会被吊销**，只能重新登录。（本仓库开发时就踩过，见
[docs/incident-2026-11-20.md](docs/incident-2026-11-20.md)。）

所以：

- 同一份 `auth.json` **只能有一个写入方**（`TokenStore` 有进程锁 + 原子写 + 0600）
- Mac 桌面端和 NAS **绝不能共用同一条链**，否则互相踢死
- 刷新失败绝不重试

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/analysis.md](docs/analysis.md) | 可行性分析：接口怎么挖的、为什么不能做成喜鹊插件 |
| [docs/incident-2026-11-20.md](docs/incident-2026-11-20.md) | 令牌链被吊销的完整复盘 |
| [docs/deploy-nas.md](docs/deploy-nas.md) | NAS/Docker 部署与面板 |
| [docs/deploy-macos.md](docs/deploy-macos.md) | macOS launchd 部署 |

## 风险

自动化自己的账号，非 Croli 官方功能。条款未授权脚本领奖，可能扣分或封号。
