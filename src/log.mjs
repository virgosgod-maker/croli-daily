import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let logFile = null;

export function initLog(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  logFile = join(stateDir, "croli-daily.log");
}

export function log(level, msg, extra) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(extra || {}) });
  if (process.env.CROLI_DAILY_QUIET !== "1") {
    (level === "error" ? console.error : console.log)(line);
  }
  if (logFile) {
    try {
      appendFileSync(logFile, line + "\n");
    } catch {
      /* 日志写失败不影响主流程 */
    }
  }
}
