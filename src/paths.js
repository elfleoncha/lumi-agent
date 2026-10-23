import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Raíz del proyecto (donde vive package.json). */
export const ROOT = process.env.LUMI_ROOT ?? path.resolve(HERE, "..");

export const PUBLIC_DIR = path.join(ROOT, "public");
export const CERTS_DIR = process.env.LUMI_CERTS_DIR ?? path.join(ROOT, "certs");
export const VENV_PYTHON =
  process.env.LUMI_PYTHON ?? path.join(ROOT, ".venv", "bin", "python");
export const FFMPEG = process.env.LUMI_FFMPEG ?? "ffmpeg";
export const SCRIPTS_DIR = path.join(ROOT, "scripts");
