# 在 macOS 上每天自动跑

推荐先手动跑通，再交给 launchd。

## 1. 准备一份独立凭据

**不要直接指向桌面端的 `auth.json`。** 桌面端和本工具会争抢同一条轮换中的 refresh token，
互相踢掉，且有触发重放吊销的风险。

```bash
mkdir -p ~/.config/croli-daily
cp "/Users/mango/Library/Application Support/Croli/auth.json" ~/.config/croli-daily/auth.json
chmod 600 ~/.config/croli-daily/auth.json
```

注意：这样复制之后，**这份副本和桌面端仍然是同一条链**。桌面端下次刷新时它会失效。
见 `docs/analysis.md` 第 5 节。真正长期稳定的做法是让其中一端独立登录。

## 2. 配置并试跑

```bash
cd ~/work/code/github/croli-daily
cp .env.example .env
$EDITOR .env          # 至少确认 CROLI_AUTH_FILE 指向上面那份副本

node src/cli.mjs status    # 只读
node src/cli.mjs run       # 真正执行
```

## 3. 交给 launchd

```bash
cp launchd/com.mango.croli-daily.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.mango.croli-daily.plist
launchctl start com.mango.croli-daily      # 立刻跑一次验证
tail -f ~/.local/state/croli-daily/croli-daily.log
```

plist 里是每天 09:10 触发，并且 `RunAtLoad` 打开——机器睡醒/登录后会补一次。

> launchd 在机器休眠期间不会补跑；开机后 `StartCalendarInterval` 会补跑错过的最近一次。
> 因为服务端幂等，多跑无害。
