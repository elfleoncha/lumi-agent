import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

import { ROOT, SCRIPTS_DIR, FFMPEG as FFMPEG_ENV } from "./paths.js";

const SCRIPTS = SCRIPTS_DIR;
const FFMPEG = FFMPEG_ENV;

export const MEDIA_DIR = path.join(ROOT, "media");
export const IN_DIR = path.join(MEDIA_DIR, "in");
export const OUT_DIR = path.join(MEDIA_DIR, "out");

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const AUDIO_EXT = new Set([".ogg", ".oga", ".mp3", ".wav", ".m4a", ".opus", ".flac", ".aac", ".webm"]);
const MAX_BYTES = 25 * 1024 * 1024;

export function ensureMediaDirs() {
  fs.mkdirSync(IN_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function safeName(att) {
  const base = (att.name || "file").replace(/[^\w.\-]+/g, "_").slice(-80);
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${base}`;
}

/** Clasifica un adjunto de Discord por tipo. */
export function attachmentKind(att) {
  const ext = path.extname(att.name || "").toLowerCase();
  const mime = (att.contentType || "").toLowerCase();
  if (mime.startsWith("image/") || IMAGE_EXT.has(ext)) return "image";
  if (mime.startsWith("audio/") || AUDIO_EXT.has(ext)) return "audio";
  // Las notas de voz de Discord llegan como audio/ogg; voz = voiceMessage
  return "file";
}

/** Descarga adjuntos de un mensaje a media/in. Devuelve [{path, kind, name}]. */
export async function downloadAttachments(attachments) {
  ensureMediaDirs();
  const out = [];
  for (const att of attachments.values()) {
    if (att.size > MAX_BYTES) {
      out.push({ path: null, kind: "too-big", name: att.name });
      continue;
    }
    const file = path.join(IN_DIR, safeName(att));
    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      out.push({ path: file, kind: attachmentKind(att), name: att.name, contentType: att.contentType });
    } catch (err) {
      out.push({ path: null, kind: "error", name: att.name, error: String(err.message ?? err) });
    }
  }
  return out;
}

/** Transcribe un audio a texto con faster-whisper (CPU, int8). */
export async function transcribe(file) {
  const model = process.env.VALEN_WHISPER_MODEL || "small";
  const { stdout } = await run(
    "python3",
    [path.join(SCRIPTS, "transcribe.py"), file, model],
    { timeout: 240000, maxBuffer: 8 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout.trim().split("\n").pop());
  return parsed;
}

/** Genera un audio de voz (ogg/opus) con gTTS + ffmpeg. Devuelve la ruta. */
export async function textToVoice(text, { lang = "es" } = {}) {
  ensureMediaDirs();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const mp3 = path.join(OUT_DIR, `${stamp}.mp3`);
  const ogg = path.join(OUT_DIR, `${stamp}.ogg`);
  await run("python3", [path.join(SCRIPTS, "tts.py"), text.slice(0, 4500), mp3, lang], {
    timeout: 120000,
  });
  try {
    await run(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", mp3, "-c:a", "libopus", "-b:a", "48k", "-ar", "48000", "-ac", "1", ogg], {
      timeout: 60000,
    });
  } catch {
    return { path: mp3, voice: false };
  }
  fs.rmSync(mp3, { force: true });
  return { path: ogg, voice: true };
}

/** Borra ficheros de salida con más de 1h. */
export function cleanupOut(maxAgeMs = 3600_000) {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(OUT_DIR)) {
      const p = path.join(OUT_DIR, f);
      if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p, { force: true });
    }
  } catch {}
}

/** Convierte adjuntos descargados en texto para el prompt de pi. */
export function buildAttachmentContext(items, log = () => {}) {
  const lines = [];
  for (const it of items) {
    if (it.kind === "image" && it.path) {
      lines.push(`- imagen (${it.name}): ${it.path}`);
    } else if (it.kind === "audio" && it.path) {
      lines.push(`- audio (${it.name}): ${it.path}`);
    } else if (it.kind === "file" && it.path) {
      lines.push(`- archivo (${it.name}): ${it.path}`);
    } else {
      lines.push(`- ${it.name}: no se pudo descargar`);
      log("adjunto fallido:", it.name, it.error ?? it.kind);
    }
  }
  return lines;
}

/** Extrae bloques ```tts ... ``` del texto de respuesta. */
export function extractVoiceBlocks(text) {
  const re = /```tts\s*\n([\s\S]*?)```/gi;
  const audios = [];
  let m;
  while ((m = re.exec(text))) {
    const t = m[1].trim();
    if (t) audios.push(t);
  }
  const clean = text.replace(re, "").replace(/\n{3,}/g, "\n\n").trim();
  return { text: clean, audios };
}

/**
 * Bloques ```send``` (o ```file``` / ```enviar```) con rutas de archivos:
 *   ```send
 *   /ruta/foto.png
 *   /ruta/informe.pdf
 *   ```
 * Devuelve el texto sin los bloques + lista de archivos válidos.
 */
export function extractSendBlocks(text) {
  const files = [];
  const clean = String(text ?? "")
    .replace(/```(?:send|file|files|enviar|adjuntar)[^\n]*\n([\s\S]*?)```/g, (_, body) => {
      for (const raw of body.split("\n")) {
        const p = raw.trim().replace(/^[-*]\s*/, "");
        if (!p || files.length >= 10) continue;
        try {
          const st = fs.statSync(p);
          if (st.isFile() && st.size > 0 && st.size <= MAX_BYTES) files.push({ path: p, size: st.size });
        } catch {
          /* ruta inexistente: se ignora */
        }
      }
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: clean, files };
}
