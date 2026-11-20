# croli-daily 项目约定

## 这是什么

Croli 每日任务的自动化工具（签到 / 首次对话）。零第三方依赖，Node 20+。

## 硬规则（都是踩过的坑换来的）

1. **单写者**：refresh token 一次性且启用重放检测，任何"重试旧 token"都会吊销整条链。
   见 `docs/incident-2026-11-20.md`。不要给刷新加自动重试，不要多进程共享凭据。
2. **不改桌面端文件**：默认 `CROLI_AUTH_FILE` 指向 `~/.local/state/croli-daily/auth.json`，
   不允许默认写 `~/Library/Application Support/Croli/auth.json`。
3. **默认不伪造**：`DAILY_CHAT_MODE` 默认 `off`。`event` 模式是伪造使用记录，需显式开启。
4. **幂等**：一律先读 `/v1/ops/home` 的 `status`，`claimed` 就跳过。服务端本身也幂等。

## 代码约定

- ESM（`.mjs`），不引入依赖，不写只用一次的抽象。
- 网络调用集中在 `src/api.mjs`；凭据读写集中在 `src/token-store.mjs` + `src/auth.mjs`。
- 错误只抛不吞；`log()` 只记上下文，不改变控制流。

## 验证

```bash
node --test test/        # 8 项，含 401、轮换落盘、锁互斥、0600 权限
node src/cli.mjs --help
```

改了刷新/凭据相关逻辑，必须补测试。
