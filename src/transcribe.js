import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VENV_PYTHON as PY } from "./paths.js";

/**
 * Transcribe audio con faster-whisper (local, CPU).
 *
 * NOTA IMPORTANTE: no usamos `WhisperModel.transcribe(archivo)` porque el
 * decoder de faster-whisper depende de PyAV y la versión instalada revienta con
 * `TypeError: open() got an unexpected keyword argument 'metadata_errors'`.
 * En su lugar decodificamos con ffmpeg a PCM float32 16 kHz mono y le pasamos
 * el array de numpy directamente. Más robusto y sin dependencias frágiles.
 */
export async function transcribe(filePath, { model = "base", language = "es" } = {}) {
  if (!fs.existsSync(PY)) {
    throw new Error("falta el venv (.venv). Crea uno con `python3 -m venv .venv && .venv/bin/pip install faster-whisper numpy`");
  }

  const script = `
import subprocess, sys, json
import numpy as np
from faster_whisper import WhisperModel

path = sys.argv[1]
lang = sys.argv[2] or None
model_name = sys.argv[3]

raw = subprocess.run(
    ["ffmpeg", "-v", "quiet", "-i", path, "-ar", "16000", "-ac", "1", "-f", "f32le", "-"],
    capture_output=True,
)
if raw.returncode != 0 or not raw.stdout:
    print(json.dumps({"error": "ffmpeg no pudo decodificar el audio: " + raw.stderr.decode()[-300:]}))
    sys.exit(0)

audio = np.frombuffer(raw.stdout, dtype=np.float32)
if audio.size == 0:
    print(json.dumps({"error": "audio vacío"}))
    sys.exit(0)

m = WhisperModel(model_name, device="cpu", compute_type="int8")
segments, info = m.transcribe(audio, language=lang, vad_filter=True, beam_size=1)
text = "".join(s.text for s in segments).strip()
print(json.dumps({
    "text": text,
    "lang": info.language,
    "prob": round(float(info.language_probability), 3),
    "duration": round(float(audio.size) / 16000.0, 2),
}))
`;

  return new Promise((resolve, reject) => {
    const child = spawn(PY, ["-c", script, filePath, language ?? "", model], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));

    // Whisper en CPU: ~1-3s por cada 10s de audio con el modelo base.
    const kill = setTimeout(() => child.kill("SIGKILL"), 5 * 60 * 1000);

    child.on("error", (e) => {
      clearTimeout(kill);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(kill);
      const last = out.trim().split("\n").filter(Boolean).pop();
      if (!last) {
        return reject(new Error(err.trim().slice(-400) || `whisper terminó con código ${code}`));
      }
      try {
        const data = JSON.parse(last);
        if (data.error) return reject(new Error(data.error));
        resolve(data);
      } catch {
        reject(new Error(`salida no válida de whisper: ${last.slice(-300)}`));
      }
    });
  });
}

export const __tmp = os.tmpdir();
export { path as _path };
