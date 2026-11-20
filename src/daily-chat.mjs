import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { log } from "./log.mjs";

const exec = promisify(execFile);

const DEFAULT_CLI_CANDIDATES = [
  "/Applications/Croli.app/Contents/Resources/bin/arm64/croli-cli",
  "/Applications/Croli.app/Contents/Resources/bin/x64/croli-cli",
  "/opt/Croli/resources/bin/x64/croli-cli",
  "/usr/bin/croli-cli",
];

export function resolveCli(cfg) {
  if (cfg.cliPath) return cfg.cliPath;
  for (const p of DEFAULT_CLI_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return "";
}

/**
 * 每日首次对话。任务由 Croli 客户端自己上报，所以只有真实对话才算数。
 *
 * real : 用 croli-cli 真的跑一次对话（唯一"诚实"的做法）
 * off  : 不做
 *
 * 注意：没有 event 模式。直接 POST /v1/ops/events 伪造 agent_turn_completed
 * 等于向服务端谎称"今天用过 AI"，属于刷量，本项目刻意不提供。
 */
export async function doDailyChat(cfg, api, token) {
  if (cfg.chatMode === "off") {
    return { done: false, reason: "DAILY_CHAT_MODE=off" };
  }
  if (cfg.chatMode !== "real") {
    throw new Error(`未知 DAILY_CHAT_MODE: ${cfg.chatMode}（只支持 real / off）`);
  }

  const cli = resolveCli(cfg);
  if (!cli) {
    throw new Error(
      "找不到 croli-cli。请把 DAILY_CHAT_MODE=real 与 CROLI_CLI 指向可执行文件，" +
        "或确认已安装 Croli 客户端。",
    );
  }

  const started = Date.now();
  const { stdout } = await exec(
    cli,
    ["-q", "-p", cfg.chatPrompt, "--cd", cfg.stateDir || homedir()],
    { timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
  );
  log("info", "已完成一次真实对话", {
    cli,
    ms: Date.now() - started,
    reply: stdout.trim().slice(-160),
  });
  return { done: true, mode: "real", cli, reply: stdout.trim().slice(-160) };
}
