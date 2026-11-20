# 坑：Croli 重启时 `auth.json` 会短暂消失

**日期**：2026-11-20（实测）

## 现象

Croli 桌面端重启的过程中（本次是 14:54 自动重启），
`~/Library/Application Support/Croli/auth.json` **在约 1–2 分钟内不存在**：

```
$ ls ~/Library/Application Support/Croli/auth.json
No such file or directory
$ curl ... /v1/account/balance
{"code":"unauthenticated"}
```

而桌面端界面此时**仍然显示已登录**（用户名正常、会话正常），说明登录态还在，
只是磁盘上的文件正在被重写（旧文件移走 → 写新文件）。

一分钟后同一路径又出现，且内容已轮换（`rt_prefix` 变了），`balance` 恢复 200。

## 影响

**对定时任务**：如果执行时刻正好撞上这个窗口，会读到「文件不存在」而失败。

本项目的 `run` 会抛错并以退出码 1 结束；`serve` 模式下**不会**写 `last-run.json`，
因此不会被误记为"今天已执行"，下一个 10 分钟 tick 会自动重试。这是设计上已经兜住的。

**对排查**：看到 `auth.json` 消失，先别急着判断"凭据丢了/被删了"——
看一下 Croli 的进程启动时间和 `logs/` 目录的修改时间，大概率是重启窗口。

## 怎么确认是不是重启

```bash
ps -o lstart= -p $(pgrep -f "Croli.app/Contents/MacOS/Croli")
ls -lat ~/Library/Application\ Support/Croli | head -5
```

如果进程启动时间与文件消失的时间吻合，就是重启窗口。

## 教训

1. **不要把「此刻读不到文件」等同于「凭据丢失」**，尤其在这类 Electron 应用上。
2. 定时任务要容忍这种瞬时缺失：读到失败就留给下一轮，别写"已完成"标记。
3. 排查时先取证（进程启动时间、目录 mtime），再下结论。
