import { config } from "./config.mjs";

export class Unauthorized extends Error {
  constructor(msg) {
    super(msg);
    this.name = "Unauthorized";
  }
}

async function call(cfg, path, opts = {}) {
  const res = await fetch(cfg.creditsBase + path, {
    method: opts.method || "GET",
    headers: {
      authorization: `Bearer ${opts.token}`,
      accept: "application/json",
      "user-agent": cfg.userAgent,
      ...(opts.body ? { "content-type": "application/json" } : {}),
    },
    body: opts.body,
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (res.status === 401) {
    throw new Unauthorized(`凭据被拒（401）：${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = new Error(`${opts.method || "GET"} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export function opsHome(cfg, token) {
  return call(cfg, "/v1/ops/home", { token });
}

export function checkin(cfg, token, taskId) {
  return call(cfg, "/v1/ops/checkin", { token, method: "POST", body: JSON.stringify({ taskId }) });
}

export function reportEvent(cfg, token, eventKey, metadata = {}) {
  return call(cfg, "/v1/ops/events", {
    token,
    method: "POST",
    body: JSON.stringify({ eventKey, eventId: crypto.randomUUID(), metadata }),
  });
}

export function getBalance(cfg, token) {
  return call(cfg, "/v1/account/balance", { token });
}

/** 把 /v1/ops/home 压成好读的任务清单 */
export function summarize(home) {
  const tasks = [];
  for (const program of home.programs || []) {
    for (const task of program.tasks || []) {
      tasks.push({
        key: task.key,
        name: task.name,
        taskId: task.id,
        status: task.status,
        claimMode: task.claimMode,
        periodKey: task.periodKey,
        periodEndsAt: task.periodEndsAt,
        progress: task.progress,
        target: task.target,
        credits: (task.milestones || []).reduce((sum, m) => sum + (m.credits || 0), 0),
        streak: task.streak || null,
      });
    }
  }
  return {
    serverTime: home.serverTime,
    timezone: home.timezone,
    claimableCount: home.claimableCount,
    tasks,
  };
}
