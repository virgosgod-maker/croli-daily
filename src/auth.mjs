import { TokenStore } from "./token-store.mjs";
import { log } from "./log.mjs";

/** access_token 提前 5 分钟视为过期，避免边界上被拒 */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export function accessTokenExpired(auth) {
  if (!auth.expires_at) return false;
  return Date.now() >= auth.expires_at * 1000 - EXPIRY_SKEW_MS;
}

/**
 * 用 refresh_token 换新的一对。Clerk 会轮换 refresh token：
 * 返回值里的 refresh_token 必须立刻落盘，旧值同时作废。
 */
export async function refreshTokens(cfg, auth) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: cfg.clientId,
    refresh_token: auth.refresh_token,
  });
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": cfg.userAgent,
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`刷新凭据失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const out = JSON.parse(text);
  if (!out.access_token || !out.refresh_token) {
    throw new Error("刷新返回缺少 access_token/refresh_token");
  }
  return {
    access_token: out.access_token,
    refresh_token: out.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (Number(out.expires_in) || 86400),
  };
}

/**
 * 取出可用 token。必要时在锁内刷新并原子落盘。
 * 注意：refresh token 一次性，多进程共享同一份文件会互相踢掉——调用方必须保证单写者。
 */
export async function ensureFreshToken(cfg, store) {
  const auth = store.read();
  if (!accessTokenExpired(auth)) return auth.access_token;

  store.acquireLock();
  try {
    const fresh = store.read();
    if (!accessTokenExpired(fresh)) return fresh.access_token;
    log("info", "access_token 已过期，刷新中");
    const next = await refreshTokens(cfg, fresh);
    store.write(next);
    log("info", "刷新完成并已写回", {
      expiresAt: new Date(next.expires_at * 1000).toISOString(),
    });
    return next.access_token;
  } finally {
    store.releaseLock();
  }
}

export function storeFor(cfg) {
  return new TokenStore(cfg.authFile);
}
