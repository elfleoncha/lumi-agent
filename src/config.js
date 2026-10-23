import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ROOT } from "./paths.js";

/** Valores por defecto: lo que no esté en config.json se rellena de aquí. */
const DEFAULTS = {
  ownerIds: [],
  guildAllowlist: [],
  sessionDir: path.join(ROOT, "sessions"),
  agentCwd: os.homedir(),
  maxQueue: 5,
  webPort: 4477,
  webPortHttps: 4478,
  browserPort: 4479,
  thinkingLevel: "minimal",
  voiceEnabled: true,
  castDevice: null,
  castVoice: "es-ES-AlvaroNeural",
  skillsDir: path.join(os.homedir(), ".pi", "agent", "skills"),
  ffmpeg: process.env.LUMI_FFMPEG ?? "ffmpeg",
};

/** Lee config.json y secret.json (secret tiene prioridad y está chmod 600). */
export function loadConfig() {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  let secret = {};
  const secretPath = path.join(ROOT, "secret.json");
  if (fs.existsSync(secretPath)) {
    secret = JSON.parse(fs.readFileSync(secretPath, "utf8"));
  }
  return {
    ...DEFAULTS,
    ...base,
    ...secret,
    token: secret.token || process.env.DISCORD_TOKEN,
  };
}

export function ensureDirs(cfg) {
  fs.mkdirSync(cfg.sessionDir, { recursive: true });
}
