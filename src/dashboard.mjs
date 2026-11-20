import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.mjs";
import { opsHome, getBalance, summarize } from "./api.mjs";
import { ensureFreshToken, storeFor } from "./auth.mjs";

const CACHE_MS = 60 * 1000;

/** 缓存一次上游结果：手机反复刷新不该把上游打成 429 */
let cache = { at: 0, data: null, error: null };

function readLastRun(cfg) {
  const f = join(cfg.stateDir, "last-run.json");
  if (!existsSync(f)) return null;
  try {
    const d = JSON.parse(readFileSync(f, "utf8"));
    return { ranAt: d.ranAt, results: d.results, balance: d.balance };
  } catch {
    return null;
  }
}

async function snapshot(cfg, force) {
  if (!force && Date.now() - cache.at < CACHE_MS && (cache.data || cache.error)) {
    return cache.data
      ? { ...cache.data, stale: true, cachedAt: cache.at }
      : { ok: false, error: cache.error, cachedAt: cache.at };
  }
  try {
    const token = await ensureFreshToken(cfg, storeFor(cfg));
    const home = summarize(await opsHome(cfg, token));
    const lastRun = readLastRun(cfg);
    let balance = null;
    let balanceStale = false;
    try {
      balance = await getBalance(cfg, token);
    } catch (err) {
      // NewAPI 上游 429 时会 503，此时沿用上次已知余额，别把面板变成 "—"
      log("warn", "面板读取余额失败，沿用上次值", { error: String(err.message || err) });
      if (lastRun?.balance != null) {
        balance = { balance: lastRun.balance, unavailable: true };
        balanceStale = true;
      }
    }
    cache = {
      at: Date.now(),
      data: { ok: true, ...home, balance, balanceStale, lastRun },
      error: null,
    };
  } catch (err) {
    cache = { at: Date.now(), data: null, error: String(err.message || err) };
  }
  return cache.data
    ? { ...cache.data, stale: false, cachedAt: cache.at }
    : { ok: false, error: cache.error, cachedAt: cache.at };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function fmt(n) {
  return typeof n === "number" ? n.toLocaleString("zh-CN") : "—";
}

/** UTC ISO -> 本地"11/21 08:00" */
function fmtWhen(iso) {
  if (!iso) return "";
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getMonth() + 1}/${t.getDate()} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

/** 参照图 2 的竖排额度块：主数字 → 进度条 → 明细，窄屏不挤压 */
function meter(title, used, total, resetIso, extra) {
  const pct = total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : 0;
  const left = total - used;
  return `<div class="meter-block">
    <div class="meter-title">${esc(title)}</div>
    <div class="meter-main"><b>${fmt(used)}</b><span class="of"> / ${fmt(total)} 积分</span></div>
    <div class="meter"><i style="width:${pct.toFixed(1)}%"></i></div>
    <div class="meter-rows">
      <div><span>剩余</span><b>${fmt(left)}</b></div>
      <div><span>已用</span><b>${pct.toFixed(1)}%</b></div>
      ${extra ? `<div><span>重置次数</span><b>${esc(String(extra).replace(/[^0-9]/g, ""))}</b></div>` : ""}
      ${resetIso ? `<div><span>下次刷新</span><b>${esc(fmtWhen(resetIso))}</b></div>` : ""}
    </div>
  </div>`;
}

function render(d) {
  const streak = (d.tasks || []).find((t) => t.key === "daily-checkin")?.streak;
  const rows = (d.tasks || [])
    .map((t) => {
      const done = t.status === "claimed";
      return `<tr><td>${esc(t.name)}</td><td class="${done ? "ok" : "todo"}">${done ? "已完成" : "待完成"}</td><td class="num">${t.credits}</td></tr>`;
    })
    .join("");
  const last = d.lastRun
    ? `${new Date(d.lastRun.ranAt).toLocaleString("zh-CN")} · ${(d.lastRun.results || [])
        .map((r) => `${r.task}=${r.action}`)
        .join(" ")}`
    : "尚无执行记录";
  const streakLine = streak
    ? `连续签到 ${streak.current} 天 · 最长 ${streak.longest} 天 · 距下次奖励还差 ${Math.max(0, streak.nextBonusAt - streak.current)} 天`
    : "";

  const b = d.balance || {};
  const trial = b.trial || null;
  const trialBlock = trial && trial.active
    ? meter(
        "今日免费额度",
        trial.usedCredits,
        trial.dailyLimitCredits,
        trial.nextResetAt,
        trial.remainingResets,
      ) +
      (trial.endsAt
        ? `<div class="sub" style="margin-top:8px">免费额度结束：${esc(fmtWhen(trial.endsAt))}</div>`
        : "")
    : `<div class="sub">免费额度未生效或已用完</div>`;

  const body = d.ok
    ? `<div class="card">
         <div class="label">总积分</div>
         <div class="big">${fmt(b.balance)}</div>
         <div class="sub">${esc(streakLine)}</div>
         ${b.unavailable ? '<div class="sub warn">上游暂时不可用，这是上次记录的余额</div>' : ""}
       </div>
       <div class="card">
         <div class="label">免费额度</div>
         ${trialBlock}
       </div>
       <div class="card">
         <div class="label">今日任务</div>
         <table>${rows}</table>
       </div>
       <div class="card">
         <div class="label">上次执行</div>
         <div class="sub">${esc(last)}</div>
       </div>`
    : `<div class="card"><div class="label">读取失败</div><div class="err">${esc(d.error)}</div>
         <div class="sub">凭据可能需要重新登录</div></div>`;

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Croli 积分</title><style>
:root{color-scheme:light}
*{box-sizing:border-box}
html,body{max-width:100%;overflow-x:hidden}
body{font-family:-apple-system,system-ui,"PingFang SC",sans-serif;margin:0;padding:18px;color:#18181b;
  background:linear-gradient(165deg,#eef4e6 0%,#f7f7f5 42%,#eef1f6 100%);background-attachment:fixed;min-height:100vh}
.card{background:rgba(255,255,255,.72);backdrop-filter:saturate(180%) blur(20px);-webkit-backdrop-filter:saturate(180%) blur(20px);
  border:1px solid rgba(255,255,255,.7);border-radius:20px;padding:18px 20px;margin-bottom:12px;
  box-shadow:0 1px 2px rgba(16,24,40,.04),0 8px 24px -12px rgba(16,24,40,.10)}
.label{font-size:12px;color:#71717a;letter-spacing:.04em;text-transform:uppercase}
.big{font-size:52px;font-weight:700;line-height:1.05;margin-top:4px;font-variant-numeric:tabular-nums}
.sub{color:#71717a;font-size:13px;margin-top:6px}
table{width:100%;border-collapse:collapse;font-size:14px;margin-top:8px}
td{padding:9px 2px;border-bottom:1px solid #f4f4f5}
tr:last-child td{border-bottom:none}
.num{text-align:right;color:#71717a;font-variant-numeric:tabular-nums}
.ok{color:#15803d;font-weight:600}.todo{color:#b45309;font-weight:600}
.err{color:#b91c1c;font-size:14px;margin-top:6px;word-break:break-all}
.warn{color:#b45309}
.meter-block{margin-top:10px}
.meter-title{font-size:14px;color:#3f3f46}
.meter-main{margin-top:8px;font-variant-numeric:tabular-nums}
.meter-main b{font-size:30px;font-weight:700;letter-spacing:-.02em}
.meter-main .of{color:#71717a;font-size:14px;margin-left:4px}
.meter{height:8px;background:rgba(120,130,120,.14);border-radius:999px;overflow:hidden;margin-top:12px}
.meter i{display:block;height:100%;background:linear-gradient(90deg,#b6f04a,#a3e635);border-radius:999px;transition:width .4s}
.meter-rows{margin-top:14px;border-top:1px solid rgba(120,130,120,.12)}
.meter-rows div{display:flex;justify-content:space-between;align-items:baseline;padding:7px 0;font-size:13px}
.meter-rows span{color:#71717a}
.meter-rows b{font-variant-numeric:tabular-nums;font-weight:600}
.foot{text-align:center;color:#a1a1aa;font-size:12px;margin-top:6px}
</style></head><body>${body}
<div class="foot">${d.stale ? "缓存" : "实时"} · ${new Date(d.cachedAt || Date.now()).toLocaleTimeString("zh-CN")} · 每 60 秒自动刷新</div>
<script>setTimeout(()=>location.reload(),60000)</script></body></html>`;
}

export function startDashboard(cfg) {
  const port = Number(process.env.DASHBOARD_PORT || 8787);
  const host = process.env.DASHBOARD_HOST || "0.0.0.0";
  const needToken = process.env.DASHBOARD_TOKEN || "";

  const srv = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (needToken && url.searchParams.get("token") !== needToken) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      return res.end("需要 token：请在地址后加 ?token=<DASHBOARD_TOKEN>");
    }
    try {
      const force = url.searchParams.get("refresh") === "1";
      const data = await snapshot(cfg, force);
      if (url.pathname === "/api/status") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify(data, null, 2));
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(render(data));
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
    }
  });

  srv.listen(port, host, () => log("info", "积分面板已启动", { url: `http://${host}:${port}/` }));
  return srv;
}
