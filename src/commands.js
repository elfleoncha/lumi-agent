import { loadConfig } from "./config.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

/**
 * Comandos de pi disponibles desde Discord, en formato slash (/nombre).
 *
 * - Los definidos en PI_BUILTINS se registran como comandos nativos de Discord.
 * - Las skills y prompt templates se descubren desde pi y se ejecutan con /run.
 */

export const PI_BUILTINS = [
  { name: "help", desc: "Lista de comandos disponibles" },
  { name: "status", desc: "Estado: modelo, tokens, coste y contexto" },
  { name: "new", desc: "Empezar conversación nueva (borra el contexto)" },
  { name: "name", desc: "Nombrar la sesión actual", arg: "nombre" },
  { name: "model", desc: "Ver o cambiar el modelo", arg: "proveedor/modelo" },
  { name: "thinking", desc: "Nivel de razonamiento", arg: "minimal|low|medium|high|max" },
  { name: "compact", desc: "Compactar el contexto", arg: "instrucciones" },
  { name: "session", desc: "Info y estadísticas de la sesión" },
  { name: "list", desc: "Listar sesiones guardadas" },
  { name: "resume", desc: "Retomar una conversación anterior", arg: "número, id o fichero" },
  { name: "link", desc: "Enlazar a una sesión por ID", arg: "sessionId" },
  { name: "linkmain", desc: "Enlazar a la sesión principal de terminal" },
  { name: "skills", desc: "Listar skills disponibles" },
  { name: "reload", desc: "Recargar skills y extensiones" },
  { name: "abort", desc: "Cancelar la respuesta en curso" },
  { name: "tts", desc: "Enviar un texto como nota de voz", arg: "texto" },
];

const STRING = 3;

/** Definiciones de comandos para la API de Discord. */
export function buildNativeCommands() {
  const out = PI_BUILTINS.map((c) => ({
    name: c.name,
    description: c.desc.slice(0, 100),
    options: c.arg
      ? [{ type: STRING, name: "valor", description: "Valor del comando".slice(0, 100) }]
      : [],
  }));
  out.push({
    name: "run",
    description: "Ejecutar una skill o prompt template de pi",
    options: [
      {
        type: STRING,
        name: "nombre",
        description: "Skill o comando (se autocompleta)",
        required: true,
        autocomplete: true,
      },
      { type: STRING, name: "texto", description: "Instrucción adicional", required: false },
    ],
  });
  return out;
}

/** Descubre skills y prompt templates cargadas en el proceso de pi del bot. */
export async function discoverDynamicCommands(pool, key) {
  return pool.withSession(key, async (session) => {
    const cmds = [];
    // Skills: se exponen como skill:<name>
    const sysPrompt = session.systemPrompt ?? "";
    const skillMatches = [...sysPrompt.matchAll(/- \*\*([a-z0-9-]+)\*\*/gi)].map((m) => m[1]);
    const skillsDir = loadConfig().skillsDir ?? "";
    let dirs = [];
    try {
      dirs = fs.readdirSync(skillsDir).filter((d) =>
        fs.existsSync(path.join(skillsDir, d, "SKILL.md")),
      );
    } catch {}
    for (const d of new Set([...dirs, ...skillMatches])) {
      let desc = "skill";
      try {
        const content = fs.readFileSync(path.join(skillsDir, d, "SKILL.md"), "utf8");
        desc = (content.match(/^description:\s*(.+)$/m)?.[1] ?? "skill").slice(0, 100);
      } catch {}
      cmds.push({ name: `skill:${d}`, desc });
    }
    return cmds;
  });
}

/** Formatea el resultado de /status de forma compacta para Discord. */
export function formatStats(stats) {
  if (!stats) return "Sin estadísticas disponibles.";
  const lines = [];
  if (stats.sessionFile) lines.push(`**Sesión:** \`${path.basename(stats.sessionFile)}\``);
  if (stats.model) lines.push(`**Modelo:** \`${stats.model}\``);
  if (stats.tokens) lines.push(`**Tokens:** ${stats.tokens}`);
  if (stats.cost !== undefined) lines.push(`**Coste:** $${Number(stats.cost).toFixed(4)}`);
  if (stats.contextUsage) {
    const u = stats.contextUsage;
    const used = u.usedTokens ?? u.tokens ?? 0;
    const max = u.maxTokens ?? u.contextWindow ?? 0;
    if (max) lines.push(`**Contexto:** ${used.toLocaleString()} / ${max.toLocaleString()}`);
  }
  return lines.join("\n") || "```json\n" + JSON.stringify(stats, null, 2).slice(0, 1500) + "\n```";
}

/** Lista sesiones guardadas en el directorio de sesiones del bot. */
export async function listBotSessions(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl") && !f.endsWith(".old"))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { file: f, mtime: st.mtime, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

/** Encuentra el JSONL de la sesión principal (la de terminal) por prefijo de ID. */
export async function findPiSession(idPrefix) {
  const all = await SessionManager.listAll();
  return all.find((s) => s.id === idPrefix || s.id?.startsWith(idPrefix));
}
