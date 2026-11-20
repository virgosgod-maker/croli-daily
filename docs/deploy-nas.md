# 在 NAS / Docker 上部署

目标：NAS 上常驻一个容器，每天自动签到 + 首次对话，并提供一个网页看积分。

## 现状（已验证）

| 能力 | 状态 |
| --- | --- |
| 镜像构建 | ✅ 在 NAS 上 build 成功 |
| 容器读任务状态 | ✅ 面板返回真实数据（余额 / 任务 / 连签） |
| 网页看积分 | ✅ `http://<nas-ip>:8787/`，手机可开 |
| 每日自动签到 | ✅ 默认 0:10 后执行，每 10 分钟校验补跑 |
| 容器写文件权限 | ✅ 以 1000:10（mango）运行，不用 sudo |

## 第一步：准备凭据（唯一的人工步骤）

容器需要**自己那条** refresh token 链。两种方式：

### A. NAS 独立登录（推荐，长期稳定）

`croli-server` 自带 headless 登录。在 NAS 上跑：

```bash
# 取登录链接
curl -sX POST -H "Authorization: Bearer <SERVER_TOKEN>" \
     -H 'content-type: application/json' -d '{}' \
     http://127.0.0.1:13081/api/desktop_auth_start
```

返回的 URL 里 `redirect_uri` 指向 NAS 的 `127.0.0.1:28743`。NAS 的 sshd 禁了 `ssh -L`，
需要在 Mac 上起一个 HTTP 中继（监听 28743，收到 /callback 后用 `ssh + curl` 转发进 NAS）。
链路已验证可用。

> ⚠️ Croli 的 Clerk 是 `single_session_mode: true`，**新登录可能踢掉 Mac 桌面端会话**。

### B. 从 Mac 复制（先跑起来用）

```bash
sshpass -f ~/Documents/docker/.nas_ssh_pw ssh mango@192.168.3.8 \
  'cat > /volume1/docker/croli-daily/data/auth.json && chmod 600 /volume1/docker/croli-daily/data/auth.json' \
  < "$HOME/Library/Application Support/Croli/auth.json"
```

**注意**：这份和桌面端是同一条链。桌面端下次刷新（24 小时内）会让它失效，反之亦然。
只适合验证。

## 第二步：启动

```bash
ssh mango@192.168.3.8
cd /volume1/docker/croli-daily
cp deploy/docker-compose.yml .
docker compose up -d
docker compose logs -f
```

## 第三步：看积分

浏览器（含手机）打开：

```
http://192.168.3.8:8787/
```

或走 Tailscale：

```
http://100.114.139.5:8787/
```

面板每 60 秒自动刷新，显示：当前积分、连续签到天数、今日两个任务状态、上次执行结果。

想要 JSON（接入别的工具 / 手机快捷指令）：

```
http://192.168.3.8:8787/api/status
```

## 关于「每日首次对话」

这项需要 NAS 上能**真的跑一次对话**，也就是要 `croli-cli` + 一个可用的 agent。

- 若只想自动签到：保持 `DAILY_CHAT_MODE=off`（默认），签到照样全自动。
- 若要连首次对话一起自动：需要在 NAS 上装 Croli 服务端 + `deepseek-acp` 之类 agent，
  并在 compose 里设 `DAILY_CHAT_MODE=real` 与 `CROLI_CLI` 路径。**这一步未验证。**

本项目**不提供**伪造事件的方式（直接 POST `/v1/ops/events` 谎报对话）。
那属于刷量，有封号风险，代码里已明确拒绝 `DAILY_CHAT_MODE=event`。

## 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 面板显示「凭据可能需要重新登录」 | token 被别处刷新掉了 | 重新取一份 `auth.json` 覆盖 |
| `invalid_grant ... already used` | refresh token 被重放 | 只能重新登录 |
| 数据目录出现 root 文件 | 用了旧镜像 | 重新 build（已改为 1000:10 运行） |
| 8787 打不开 | 端口未映射 / 防火墙 | 检查 compose 的 ports 与 NAS 防火墙 |
| 突然「找不到凭据文件」 | 可能是 Croli 桌面端正好在重启 | 见 [pitfall-auth-window.md](pitfall-auth-window.md)，一分钟后再试 |
