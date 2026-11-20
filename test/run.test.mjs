import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 把模块配置指向本地假服务：必须在 import 业务模块之前设置
const state = {
  home: null,
  checkinCalls: 0,
  eventCalls: [],
  refreshCalls: 0,
  refreshRotations: [],
  balanceDown: false,
  rejectNext: 0,
};

function task(key, id, status) {
  return {
    id,
    key,
    name: key,
    status,
    claimMode: "auto",
    periodKey: "2026-11-20",
    progress: status === "claimed" ? 1 : 0,
    target: 1,
    milestones: [{ index: 0, count: 1, credits: id === 2 ? 200 : 100, status }],
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === "/oauth/token" && req.method === "POST") {
    state.refreshCalls += 1;
    state.refreshRotations.push(state.refreshCalls);
    return send(200, {
      access_token: "access-" + state.refreshCalls,
      refresh_token: "refresh-" + state.refreshCalls,
      expires_in: 86400,
      token_type: "bearer",
    });
  }

  if (state.rejectNext > 0) {
    state.rejectNext -= 1;
    return send(401, { code: "unauthenticated" });
  }

  if (url.pathname === "/credits/v1/ops/home") {
    return send(200, {
      serverTime: "2026-11-20T05:00:00Z",
      timezone: "Asia/Shanghai",
      claimableCount: 0,
      programs: [{ id: 1, key: "p", tasks: state.home() }],
    });
  }
  if (url.pathname === "/credits/v1/ops/checkin" && req.method === "POST") {
    state.checkinCalls += 1;
    state.checkedIn = true;
    return send(200, { alreadyCheckedIn: false, creditsAwarded: 100 });
  }
  if (url.pathname === "/credits/v1/ops/events" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      state.eventCalls.push(JSON.parse(body));
      send(200, { accepted: true, duplicate: false });
    });
    return;
  }
  if (url.pathname === "/credits/v1/account/balance") {
    if (state.balanceDown) {
      return send(503, { code: "newapi_unavailable", message: "newapi unavailable: 429" });
    }
    return send(200, { balance: 100, trial: { remainingCredits: 5 } });
  }
  send(404, { code: "not_found" });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = "http://127.0.0.1:" + server.address().port;

const dir = mkdtempSync(join(tmpdir(), "croli-daily-"));
const authFile = join(dir, "auth.json");

state.home = () => [task("daily-checkin", 1, state.checkedIn ? "claimed" : "pending")];

const { config } = await import("../src/config.mjs");
const { TokenStore } = await import("../src/token-store.mjs");
const { ensureFreshToken, accessTokenExpired } = await import("../src/auth.mjs");
const { checkin, opsHome } = await import("../src/api.mjs");

function makeCfg() {
  return {
    ...config(),
    authFile,
    stateDir: dir,
    creditsBase: base + "/credits",
    tokenUrl: base + "/oauth/token",
    chatMode: "off",
    userAgent: "test",
  };
}

function writeAuth(pair) {
  writeFileSync(authFile, JSON.stringify(pair), { mode: 0o600 });
}

test("未过期时直接复用 access_token，不碰 refresh", async () => {
  writeAuth({ access_token: "a0", refresh_token: "r0", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  const cfg = makeCfg();
  const before = state.refreshCalls;
  const tok = await ensureFreshToken(cfg, new TokenStore(authFile));
  assert.equal(tok, "a0");
  assert.equal(state.refreshCalls, before);
});

test("过期时刷新并把轮换后的 refresh_token 落盘", async () => {
  writeAuth({ access_token: "old", refresh_token: "r-old", expires_at: Math.floor(Date.now() / 1000) - 10 });
  const cfg = makeCfg();
  const before = state.refreshCalls;
  const tok = await ensureFreshToken(cfg, new TokenStore(authFile));
  assert.equal(state.refreshCalls, before + 1);
  assert.equal(tok, "access-" + state.refreshCalls);
  const saved = JSON.parse(readFileSync(authFile, "utf8"));
  assert.equal(saved.refresh_token, "refresh-" + state.refreshCalls, "轮换后的 refresh token 必须写回");
  assert.ok(!accessTokenExpired(saved), "写回的过期时间必须在未来");
});

test("签到后 ops/home 报 claimed，重复执行不再重复调用", async () => {
  const cfg = makeCfg();
  const store = new TokenStore(authFile);
  writeAuth({ access_token: "a1", refresh_token: "r1", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  const tok = await ensureFreshToken(cfg, store);

  state.checkedIn = false;
  const first = (await opsHome(cfg, tok)).programs[0].tasks[0];
  assert.equal(first.status, "pending");
  const callsBefore = state.checkinCalls;
  await checkin(cfg, tok, 1);
  assert.equal(state.checkinCalls, callsBefore + 1);

  const second = (await opsHome(cfg, tok)).programs[0].tasks[0];
  assert.equal(second.status, "claimed", "签到后应报告 claimed，作为幂等依据");
});

test("余额接口 503 时签到链路不受影响（tryBalance 容错）", async () => {
  const cfg = makeCfg();
  writeAuth({ access_token: "a9", refresh_token: "r9", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  const store = new TokenStore(authFile);
  const tok = await ensureFreshToken(cfg, store);
  const { getBalance } = await import("../src/api.mjs");

  state.balanceDown = true;
  try {
    // ops/home 仍然正常——签到只依赖它
    const home = await opsHome(cfg, tok);
    assert.ok(home.programs, "ops/home 应正常返回");
    // 余额单独失败并抛出，由调用方决定是否忽略
    await assert.rejects(() => getBalance(cfg, tok), /503/);
  } finally {
    state.balanceDown = false;
  }
});

test("401 抛出 Unauthorized，便于上层判定需要重新登录", async () => {
  const cfg = makeCfg();
  state.rejectNext = 1;
  const err = await opsHome(cfg, "bad").then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "应抛错");
  assert.equal(err.name, "Unauthorized");
});

test("不提供伪造事件模式：event 不是合法 DAILY_CHAT_MODE", async () => {
  const cfg = makeCfg();
  const { doDailyChat } = await import("../src/daily-chat.mjs");
  const before = state.eventCalls.length;
  await assert.rejects(
    () => doDailyChat({ ...cfg, chatMode: "event" }, null, "a1"),
    /未知 DAILY_CHAT_MODE/,
    "伪造上报必须不可用",
  );
  assert.equal(state.eventCalls.length, before, "不得发出任何伪造事件");
});

test("chatMode=off 时不做任何事", async () => {
  const { doDailyChat } = await import("../src/daily-chat.mjs");
  const res = await doDailyChat({ ...makeCfg(), chatMode: "off" }, null, "a1");
  assert.equal(res.done, false);
  assert.equal(state.eventCalls.length, 0);
});

test("锁被占用时拒绝并发刷新（防 token 互踢）", async () => {
  writeAuth({ access_token: "old", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) - 10 });
  const store = new TokenStore(authFile);
  store.acquireLock();
  try {
    await assert.rejects(
      () => ensureFreshToken(makeCfg(), new TokenStore(authFile)),
      /持有凭据锁/,
    );
  } finally {
    store.releaseLock();
  }
});

test("凭据文件权限为 0600", async () => {
  writeAuth({ access_token: "a", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 60 });
  const store = new TokenStore(authFile);
  const before = JSON.parse(readFileSync(authFile, "utf8"));
  store.write({ ...before, refresh_token: "r2" });
  const { statSync } = await import("node:fs");
  const mode = statSync(authFile).mode & 0o777;
  assert.equal(mode, 0o600);
});

test("清理", () => server.close());
