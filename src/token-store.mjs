import { readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./log.mjs";

const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * refresh token 一次性（用过即失效，重放旧值会吊销整条链），
 * 所以凭据只允许一个写入方：进程级锁 + 原子写 + 0600。
 */
export class TokenStore {
  constructor(file) {
    this.file = file;
    this.lockFile = file + ".lock";
  }

  acquireLock() {
    mkdirSync(dirname(this.file), { recursive: true });
    if (existsSync(this.lockFile)) {
      const age = Date.now() - statSync(this.lockFile).mtimeMs;
      if (age < LOCK_STALE_MS) {
        throw new Error(`另一个进程持有凭据锁（${this.lockFile}，已 ${Math.round(age / 1000)}s）`);
      }
      log("warn", "清理过期凭据锁", { ageMs: age });
      unlinkSync(this.lockFile);
    }
    writeFileSync(this.lockFile, String(process.pid), { mode: 0o600 });
  }

  releaseLock() {
    try {
      unlinkSync(this.lockFile);
    } catch {
      /* 已不存在 */
    }
  }

  read() {
    const data = JSON.parse(readFileSync(this.file, "utf8"));
    if (!data.access_token || !data.refresh_token) {
      throw new Error(`凭据文件缺少 access_token/refresh_token: ${this.file}`);
    }
    return data;
  }

  write(data) {
    const tmp = `${this.file}.tmp-${process.pid}`;
    const body = JSON.stringify(
      { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at },
      null,
      2,
    );
    writeFileSync(tmp, body, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    return this.file;
  }
}
