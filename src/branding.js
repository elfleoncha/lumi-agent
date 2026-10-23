import fs from "node:fs";
import path from "node:path";

import { ROOT } from "./paths.js";

/**
 * Branding de la app. Orden de prioridad:
 *   1. variables de entorno (LUMI_NAME, ...)
 *   2. config.json (appName, appTagline, ...)
 *   3. valores por defecto ("Lumi")
 */
function desdeConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

const cfg = desdeConfig();

export const branding = {
  name: process.env.LUMI_NAME ?? cfg.appName ?? "Lumi",
  short: process.env.LUMI_SHORT ?? cfg.appShort ?? (process.env.LUMI_NAME ?? cfg.appName ?? "Lumi"),
  tagline:
    process.env.LUMI_TAGLINE ?? cfg.appTagline ?? "Tu asistente personal, en casa y en tu bolsillo",
  description:
    cfg.appDescription ??
    "Asistente con Discord, panel web, voz en altavoces, archivos y memoria persistente.",
  emoji: cfg.appEmoji ?? "🐱",
  colors: {
    bg: "#0a0a0f",
    fg: "#f6f5fa",
    accent: "#a78bfa",
  },
  credits: "Construido sobre pi (@earendil-works/pi-coding-agent), MIT.",
};

export default branding;
