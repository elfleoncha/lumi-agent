#!/usr/bin/env node
/**
 * Lumi · terminal propia (cliente ligero del servidor Lumi).
 *
 *   lumi                 chat interactivo
 *   lumi ask "texto"     una pregunta y sale
 *   lumi setup           configura servidor y contraseña
 *   lumi status          estado del servidor
 *
 * Sólo usa módulos nativos de Node (sin dependencias).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "lumi",
);
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  accent: "\x1b[38;5;141m",
  ok: "\x1b[38;5;114m",
  warn: "\x1b[38;5;214m",
  err: "\x1b[38;5;203m",
};

function cargarConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function guardarConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

const cfg = {
  url: process.env.LUMI_URL || "http://127.0.0.1:4477",
  password: process.env.LUMI_PASS || "",
  name: process.env.LUMI_NAME || "Lumi",
  ...cargarConfig(),
};
if (process.env.LUMI_URL) cfg.url = process.env.LUMI_URL;
if (process.env.LUMI_PASS) cfg.password = process.env.LUMI_PASS;

let token = null;

async function login() {
  const res = await fetch(`${cfg.url}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: cfg.password }),
  });
  if (!res.ok) throw new Error(`no puedo entrar (${res.status}). Revisa la contraseña con: lumi setup`);
  ({ token } = await res.json());
}

function cabecera() {
  console.log(
    `\n  ${C.accent}${C.bold}${cfg.name}${C.reset} ${C.dim}· terminal${C.reset}\n` +
      `  ${C.dim}${cfg.url}  ·  /help para comandos  ·  Ctrl+C para salir${C.reset}\n`,
  );
}

function prompt(rl) {
  rl.setPrompt(`${C.accent}›${C.reset} `);
  rl.prompt();
}

async function preguntar(texto, onDelta) {
  const res = await fetch(`${cfg.url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text: texto }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let acc = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const partes = buf.split("\n\n");
    buf = partes.pop() ?? "";
    for (const p of partes) {
      const linea = p.split("\n").find((l) => l.startsWith("data: "));
      if (!linea) continue;
      let ev;
      try {
        ev = JSON.parse(linea.slice(6));
      } catch {
        continue;
      }
      if (ev.type === "delta") {
        acc += ev.text;
        onDelta?.(ev.text, acc);
      } else if (ev.type === "done") {
        acc = ev.text || acc;
      } else if (ev.type === "activity" && ev.kind === "tool_start") {
        process.stderr.write(`\r${C.dim}  ⚙ ${ev.name} ${ev.args ?? ""}${C.reset}\n`);
      } else if (ev.type === "error") {
        throw new Error(ev.error);
      }
    }
  }
  return acc;
}

async function setup() {
  const r = readline.createInterface({ input: process.stdin, output: process.stdout });
  const url = (await new Promise((res) => r.question(`Servidor (${cfg.url}): `, res))) || cfg.url;
  const pass = await new Promise((res) => r.question("Contraseña: ", res));
  r.close();
  guardarConfig({ ...cargarConfig(), url: url.trim(), password: pass });
  console.log(`${C.ok}Guardado en ${CONFIG_FILE}${C.reset}`);
}

async function estado() {
  await login();
  const res = await fetch(`${cfg.url}/api/stats`, { headers: { Authorization: `Bearer ${token}` } });
  const d = await res.json();
  console.log(JSON.stringify(d, null, 2));
}

async function main() {
  const [, , cmd, ...resto] = process.argv;

  if (cmd === "setup") return setup();
  if (!cfg.password) {
    console.log(`${C.warn}Primera vez: configura el servidor y la contraseña.${C.reset}`);
    await setup();
    return;
  }
  await login();

  if (cmd === "status") return estado();

  if (cmd === "ask") {
    const texto = resto.join(" ");
    if (!texto) {
      console.error("uso: lumi ask \"tu pregunta\"");
      process.exit(1);
    }
    let escrito = 0;
    const r = await preguntar(texto, (_d, acc) => {
      const nuevo = acc.slice(escrito);
      escrito = acc.length;
      process.stdout.write(nuevo);
    });
    process.stdout.write("\n");
    return r;
  }

  cabecera();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let ocupado = false;
  prompt(rl);

  rl.on("line", async (linea) => {
    const texto = linea.trim();
    if (!texto) return prompt(rl);
    if (ocupado) {
      console.log(`${C.warn}espera, estoy respondiendo…${C.reset}`);
      return prompt(rl);
    }

    if (texto === "/exit" || texto === "/quit") {
      rl.close();
      return;
    }
    if (texto === "/help") {
      console.log(
        [
          "",
          `  ${C.bold}Comandos${C.reset}`,
          "  /status   modelo, tokens y coste",
          "  /new      conversación nueva",
          "  /model    ver o cambiar modelo",
          "  /help     esta ayuda",
          "  /exit     salir",
          "",
        ].join("\n"),
      );
      return prompt(rl);
    }
    if (texto === "/status" || texto === "/new" || texto.startsWith("/model")) {
      const [name, ...arg] = texto.slice(1).split(" ");
      try {
        const res = await fetch(`${cfg.url}/api/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name, arg: arg.join(" ") }),
        });
        const d = await res.json();
        console.log(`${C.dim}${d.text ?? d.error}${C.reset}\n`);
      } catch (e) {
        console.log(`${C.err}${e.message}${C.reset}`);
      }
      return prompt(rl);
    }

    ocupado = true;
    let escrito = 0;
    try {
      await preguntar(texto, (_d, acc) => {
        const nuevo = acc.slice(escrito);
        escrito = acc.length;
        process.stdout.write(nuevo);
      });
      process.stdout.write("\n\n");
    } catch (e) {
      console.log(`${C.err}⚠ ${e.message}${C.reset}\n`);
    }
    ocupado = false;
    prompt(rl);
  });

  rl.on("close", () => {
    console.log(`${C.dim}  hasta luego${C.reset}\n`);
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(`${C.err}${e.message}${C.reset}`);
  process.exit(1);
});
