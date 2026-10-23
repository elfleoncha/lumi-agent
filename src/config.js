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
  // Rutas configurables: útil para probar con una config temporal sin tocar la
  // de verdad (LUMI_CONFIG / LUMI_SECRET).
  const configPath = process.env.LUMI_CONFIG || path.join(ROOT, "config.json");
  const secretPath = process.env.LUMI_SECRET || path.join(ROOT, "secret.json");
  const base = JSON.parse(fs.readFileSync(configPath, "utf8"));
  let secret = {};
  if (fs.existsSync(secretPath)) {
    secret = JSON.parse(fs.readFileSync(secretPath, "utf8"));
  }
  const cfg = {
    ...DEFAULTS,
    ...base,
    ...secret,
    token: secret.token || process.env.DISCORD_TOKEN,
  };

  // Variables de entorno: lo que documenta .env.example tiene que funcionar de
  // verdad (en Docker es la única forma cómoda de configurarlo).
  const env = process.env;
  const num = (v) => (v === undefined || v === "" ? undefined : Number(v));
  const textos = {
    LUMI_NAME: "appName",
    LUMI_TAGLINE: "appTagline",
    LUMI_SESSION_DIR: "sessionDir",
    LUMI_AGENT_CWD: "agentCwd",
    WEB_PASSWORD: "webPassword",
    LUMI_MODEL: "model",
    LUMI_THINKING: "thinkingLevel",
    NTFY_TOPIC: "ntfyTopic",
    LUMI_CAST_DEVICE: "castDevice",
  };
  for (const [variable, clave] of Object.entries(textos)) {
    if (env[variable]) cfg[clave] = env[variable];
  }
  const numeros = {
    WEB_PORT: "webPort",
    WEB_PORT_HTTPS: "webPortHttps",
    LUMI_BROWSER_PORT: "browserPort",
    LUMI_SESSION_MAX_MB: "sessionMaxMb",
  };
  for (const [variable, clave] of Object.entries(numeros)) {
    const valor = num(env[variable]);
    if (valor !== undefined && !Number.isNaN(valor)) cfg[clave] = valor;
  }
  if (env.LUMI_OWNER_IDS) {
    cfg.ownerIds = env.LUMI_OWNER_IDS.split(",").map((x) => x.trim()).filter(Boolean);
  }
  // Clave de la conversación principal. Sin dueño (modo solo web) usamos
  // "local": antes salía "dm-undefined" y al añadir el ID la sesión se perdía.
  cfg.ownerKey = cfg.ownerIds?.[0] ? `dm-${cfg.ownerIds[0]}` : "dm-local";
  return cfg;
}

export function ensureDirs(cfg) {
  fs.mkdirSync(cfg.sessionDir, { recursive: true });
}
