import { loadConfig } from "./config.js";

/**
 * Notificación push al móvil vía ntfy.sh.
 * El tema (topic) es el "secreto": quien lo conozca puede enviarte avisos.
 */
export async function notify(title, message, { tags = ["robot"], priority = "default", url } = {}) {
  const cfg = loadConfig();
  const topic = cfg.ntfyTopic;
  if (!topic) return { ok: false, error: "falta ntfyTopic en config.json" };
  // las cabeceras HTTP solo admiten latin-1: los emojis van en el cuerpo
  const safeTitle = String(title ?? "").replace(/[^\x20-\x7E\xA0-\xFF]/g, "").trim().slice(0, 100) || "Lumi";
  try {
    const res = await fetch(`https://ntfy.sh/${topic}`, {
      method: "POST",
      headers: {
        Title: safeTitle,
        Tags: tags.join(","),
        Priority: priority,
        ...(url ? { Click: url } : {}),
      },
      body: message,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
