#!/usr/bin/env node
import { writeFileSync, readFileSync, copyFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config, isDesktopAuthFile } from "./config.mjs";
import { log, initLog } from "./log.mjs";
import { storeFor, ensureFreshToken } from "./auth.mjs";
import { opsHome, checkin, getBalance, summarize } from "./api.mjs";
import { doDailyChat } from "./daily-chat.mjs";
import { startDashboard } from "./dashboard.mjs";

const CHECKIN_TASK_ID = 1;
const FIRST_CHAT_TASK_ID = 2;

function usage() {
  console.log(`croli-daily —— Croli 每日签到 / 每日首次对话

用法：
  croli-daily status              只读：任务状态与余额
  croli-daily run                 执行今日任务（幂等）
  croli-daily serve               启动常驻：定时执行 + 网页看积分
  croli-daily sync-auth <src>     用另一台机器的 auth.json 覆盖本地凭据

环境变量见 .env.example，凭据文件由 CROLI_AUTH_FILE 指定。
`);
}

async function withToken(cfg) {
  const store = storeFor(cfg);
  if (!existsSync(cfg.authFile)) {
    throw new Error(
      `找不到凭据文件 ${cfg.authFile}\n` +
        "把桌面端的 auth.json 复制到该路径，或设置 CROLI_AUTH_FILE。",
    );
  }
  if (isDesktopAuthFile(cfg.authFile)) {
    log(
      "warn",
      "正在直接使用桌面端 auth.json：桌面端和本工具会争抢同一条轮换中的 refresh token，" +
        "建议把凭据复制到独立目录并只由一处刷新",
      { authFile: cfg.authFile },
    );
  }
  const token = await ensureFreshToken(cfg, store);
  return token;
}

/**
 * 余额走的是另一条上游（NewAPI），它 429 时会返回 503。
 * 签到只依赖 ops/home，所以余额失败不能拖垮主流程。
 */
async function tryBalance(cfg, token) {
  try {
    return { ok: true, ...(await getBalance(cfg, token)) };
  } catch (err) {
    log("warn", "读取余额失败（不影响签到）", { error: String(err.message || err) });
    return { ok: false, error: String(err.message || err) };
  }
}

async function cmdStatus(cfg) {
  const token = await withToken(cfg);
  const home = summarize(await opsHome(cfg, token));
  const bal = await tryBalance(cfg, token);
  console.log(JSON.stringify({ ...home, balance: bal }, null, 2));
  return home;
}

async function cmdRun(cfg) {
  const token = await withToken(cfg);
  const before = summarize(await opsHome(cfg, token));
  const results = [];

  const checkinTask = before.tasks.find((t) => t.taskId === CHECKIN_TASK_ID);
  if (!checkinTask) {
    results.push({ task: "daily-checkin", action: "skip", reason: "服务端没有该任务" });
  } else if (checkinTask.status === "claimed") {
    results.push({ task: "daily-checkin", action: "skip", reason: "今天已签到" });
  } else {
    const res = await checkin(cfg, token, CHECKIN_TASK_ID);
    results.push({ task: "daily-checkin", action: "checkin", res });
  }

  const chatTask = before.tasks.find((t) => t.taskId === FIRST_CHAT_TASK_ID);
  if (!chatTask) {
    results.push({ task: "daily-first-chat", action: "skip", reason: "服务端没有该任务" });
  } else if (chatTask.status === "claimed") {
    results.push({ task: "daily-first-chat", action: "skip", reason: "今天首次对话奖励已领" });
  } else {
    try {
      const res = await doDailyChat(cfg, null, token);
      results.push({ task: "daily-first-chat", action: res.done ? res.mode : "skip", res });
    } catch (err) {
      results.push({ task: "daily-first-chat", action: "error", error: String(err.message || err) });
    }
  }

  const after = summarize(await opsHome(cfg, token));
  const bal = await tryBalance(cfg, token);
  const out = {
    ranAt: new Date().toISOString(),
    results,
    tasks: after.tasks,
    balance: bal.ok ? bal.balance : null,
    trial: bal.ok ? bal.trial : null,
    ...(bal.ok ? {} : { balanceError: bal.error }),
  };
  console.log(JSON.stringify(out, null, 2));
  if (cfg.stateDir) {
    mkdirSync(cfg.stateDir, { recursive: true });
    writeFileSync(cfg.stateDir + "/last-run.json", JSON.stringify(out, null, 2));
  }
  return results;
}

function cmdSyncAuth(cfg, src) {
  if (!src) throw new Error("用法：croli-daily sync-auth <src-auth.json>");
  const data = JSON.parse(readFileSync(src, "utf8"));
  if (!data.access_token || !data.refresh_token) throw new Error("源文件缺少 token 字段");
  mkdirSync(dirname(cfg.authFile), { recursive: true });
  copyFileSync(src, cfg.authFile);
  chmodSync(cfg.authFile, 0o600);
  log("info", "凭据已同步", { from: src, to: cfg.authFile });
}

/**
 * 常驻模式：网页面板 + 每日定时执行。
 *
 * 服务端周期在北京时间 0 点切换，所以默认在 0:10 执行。
 * 每 10 分钟醒一次检查：若"今天还没成功跑过"就补跑——
 * 因此容器重启、短暂断网、上游 502 都不会漏掉当天的任务。
 */
async function cmdServe(cfg) {
  const atHour = Number(process.env.RUN_AT_HOUR || 0);
  const atMinute = Number(process.env.RUN_AT_MINUTE || 10);
  startDashboard(cfg);

  const lastRunPath = cfg.stateDir + "/last-run.json";

  const alreadyRanToday = () => {
    try {
      const d = JSON.parse(readFileSync(lastRunPath, "utf8"));
      if (d.failed) return false;
      const ran = new Date(d.ranAt);
      const now = new Date();
      return (
        ran.getFullYear() === now.getFullYear() &&
        ran.getMonth() === now.getMonth() &&
        ran.getDate() === now.getDate()
      );
    } catch {
      return false;
    }
  };

  const dueNow = () => {
    const now = new Date();
    const target = new Date(now);
    target.setHours(atHour, atMinute, 0, 0);
    return now >= target;
  };

  const tick = async () => {
    if (!dueNow()) return;
    if (alreadyRanToday()) return;
    try {
      log("info", "到达执行窗口，开始执行");
      await cmdRun(cfg);
    } catch (err) {
      // 失败也写一份标记，让本次不算"已完成"，下个 tick 会重试
      log("error", "执行失败，稍后重试", { error: String(err.message || err) });
      try {
        mkdirSync(cfg.stateDir, { recursive: true });
        writeFileSync(
          lastRunPath,
          JSON.stringify({ ranAt: new Date().toISOString(), failed: true, error: String(err.message || err) }, null, 2),
        );
      } catch {
        /* 标记写失败不影响重试 */
      }
    }
  };

  await tick();
  setInterval(tick, 10 * 60 * 1000);
  log("info", `常驻已启动：每天 ${atHour}:${String(atMinute).padStart(2, "0")} 后执行，每 10 分钟校验一次`);
  return new Promise(() => {});
}

async function main() {
  const [cmd = "status", arg] = process.argv.slice(2);
  const cfg = config();
  initLog(cfg.stateDir);
  if (cmd === "-h" || cmd === "--help" || cmd === "help") return usage();
  if (cmd === "status") return cmdStatus(cfg);
  if (cmd === "run") return cmdRun(cfg);
  if (cmd === "sync-auth") return cmdSyncAuth(cfg, arg);
  if (cmd === "serve") return cmdServe(cfg);
  usage();
  process.exitCode = 2;
}

main().catch((err) => {
  log("error", err.message || String(err));
  process.exitCode = 1;
});
