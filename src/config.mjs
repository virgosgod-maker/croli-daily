import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function expandHome(p) {
  if (!p) return p;
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

export function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

export const DESKTOP_AUTH_FILES = [
  join(homedir(), "Library/Application Support/Croli/auth.json"),
  join(homedir(), ".config/croli/auth.json"),
];

export function config() {
  loadEnvFile(process.env.CROLI_DAILY_ENV || join(process.cwd(), ".env"));
  const stateDir = expandHome(process.env.CROLI_STATE_DIR || "~/.local/state/croli-daily");
  return {
    authFile: expandHome(process.env.CROLI_AUTH_FILE || join(stateDir, "auth.json")),
    stateDir,
    clientId: process.env.CROLI_CLERK_CLIENT_ID || "znV4SkcUsY1AektQ",
    tokenUrl: process.env.CROLI_CLERK_TOKEN_URL || "https://clerk.croli.net/oauth/token",
    creditsBase: (process.env.CROLI_CREDITS_BASE || "https://ds.croli.net/credits").replace(/\/$/, ""),
    chatMode: process.env.DAILY_CHAT_MODE || "off",
    cliPath: process.env.CROLI_CLI || "",
    chatPrompt: process.env.DAILY_CHAT_PROMPT || "早，今天也一切顺利吗？一句话就好。",
    userAgent: process.env.CROLI_USER_AGENT || "croli/0.0.17",
  };
}

export function isDesktopAuthFile(file) {
  return DESKTOP_AUTH_FILES.includes(file);
}
