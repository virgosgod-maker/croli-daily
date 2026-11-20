# 在 NAS 上跑真实对话（让「每日首次对话」自动完成）

## 现状：全链路已打通，卡在账号额度

**已验证跑通的部分**（NAS 容器内，实测）：

| 环节 | 结果 |
| --- | --- |
| `croli-server` Linux 版在容器里启动 | ✅ 监听 3080，打印 Token |
| `croli-cli` 连上并列出 agent | ✅ `deepseek: INSTALLED yes` |
| `deepseek-acp` 安装（Node 24 镜像） | ✅ 启动、握手、发出 ACP turn |
| 请求真的打到模型层 | ✅ 越过配置层，进入计费层 |

**卡住的地方**（不是配置问题）：

```
Key limit exceeded (total limit).
$50.01 of $50.00 used; does not reset.
```

关键证据：**Mac 桌面端跑同样的对话，报一模一样的错**。

```bash
$ /Applications/Croli.app/Contents/Resources/bin/arm64/croli-cli \
    -a deepseek --cd /tmp -p "只回复两个字：收到"
croli-cli: ACP protocol error: Internal error: turn failed:
  Key limit exceeded (total limit). $50.01 of $50.00 used; does not reset.
```

所以这是**账号侧的模型 key 额度用尽**，与 NAS、与 Docker、与本项目都无关。
在这把 key 的额度恢复之前，任何人（包括桌面端）都跑不成对话。

## 我在 NAS 上修掉的两个真问题

配置链路本身有两个坑，都已解决并写进镜像：

### 1. `thinking: {type:"enabled"}` 被中转拒绝

`deepseek-acp` 的 `boot.js` 把 `reasoningEffort` 硬编码成 `'high'`，
线上发 `thinking:{type:"enabled"}`，ds.croli.net 直接回：

```
400 Invalid Anthropic Messages API request
```

实测对照：

| 发送 | 结果 |
| --- | --- |
| 不带 thinking | 200 |
| `thinking:{type:"enabled"}` | **400** |
| `thinking:{type:"disabled"}` | 200 |

镜像里用 `sed` 把它改成 `'off'`（见 `Dockerfile.agent`）。

### 2. `max_tokens: 256000` 触发 402

`dsh-llm-deepseek` 的 `DEFAULT_MAX_TOKENS = 256000`，中转按这个数预留额度：

| max_tokens | 结果 |
| --- | --- |
| 256000 | 402 需要更多 credits |
| 32000 | 200 |

用 `$DSH_HOME/settings.yaml` 的 `maxTokens: 32000` 覆盖（见 `docker/settings.agent.yaml`）。

## 额度恢复后怎么用

```bash
cd /volume1/docker/croli-daily
docker compose -f deploy/docker-compose.agent.yml up -d
```

然后 `croli-daily` 容器里设：

```yaml
DAILY_CHAT_MODE: real
CROLI_CLI_URL: http://croli-agent:3080
```

## 这套东西的边界

- 对话**真的**发给了模型，服务端自己判定「今日首次对话」，不伪造任何事件。
- 每次对话会真实消耗积分（今天实测：190 分）。
- key 额度是账号级硬上限（$50 / 不重置），用完就没法再对话——这是平台的设计，绕不过去。
