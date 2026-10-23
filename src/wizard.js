import express from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Asistente de primer arranque.
 *
 * Sin ningún fichero de configuración no hay nada que arrancar, así que en vez
 * de morir con un error en la consola se levanta un formulario mínimo en el
 * puerto del panel. Al guardar escribe config.json y secret.json (chmod 600) y
 * el proceso termina: systemd/PM2/Docker lo vuelven a arrancar ya configurado.
 *
 * Es lo que hace que `docker compose up` no necesite editar JSON a mano.
 */
/** ¿Hay algo que nos vuelva a arrancar? (systemd, PM2 o Docker) */
function bajoSupervisor() {
  if (process.env.INVOCATION_ID) return true; // systemd
  // `pm_id` solo lo pone PM2 al proceso que gestiona (PM2_HOME se hereda y engaña)
  if (process.env.pm_id) return true;
  try {
    if (fs.existsSync("/.dockerenv")) return true;
    if (fs.readFileSync("/proc/1/cgroup", "utf8").includes("docker")) return true;
  } catch {}
  return false;
}

/**
 * Tras guardar hay que arrancar ya configurado.
 * Si nos supervisa alguien, basta con salir: systemd/PM2/Docker reinician.
 * Si no (típico `node src/index.js` en una terminal), nos relanzamos nosotros,
 * porque si no el proceso muere y el panel se queda caído.
 */
function reiniciar() {
  if (bajoSupervisor()) {
    process.exit(0);
  }
  try {
    const hijo = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    });
    hijo.unref();
    console.log(new Date().toISOString(), "asistente: relanzando Lumi ya configurado");
  } catch (e) {
    console.error("No pude relanzar solo. Arranca a mano: node src/index.js");
  }
  process.exit(0);
}

export function startWizard({ port = 4477, host = "0.0.0.0", configPath, secretPath, home, log }) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.disable("x-powered-by");

  let guardado = false;

  app.get("/", (_req, res) => {
    res.type("html").send(PAGINA);
  });

  app.post("/api/setup", (req, res) => {
    const b = req.body ?? {};
    const nombre = String(b.appName || "Lumi").trim().slice(0, 40);
    const pin = String(b.webPassword || "");
    if (pin.length < 4) return res.status(400).json({ error: "El PIN debe tener al menos 4 caracteres" });

    const token = String(b.token || "").trim();
    const owners = String(b.ownerIds || "")
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter((x) => /^\d{10,25}$/.test(x));

    const config = {
      ownerIds: owners,
      guildAllowlist: [],
      sessionDir: path.join(path.dirname(configPath), "sessions"),
      agentCwd: b.agentCwd ? String(b.agentCwd) : home,
      maxQueue: 5,
      webPort: Number(b.webPort) || port,
      webPortHttps: Number(b.webPortHttps) || 0,
      browserPort: 4479,
      thinkingLevel: "minimal",
      voiceEnabled: false,
      ntfyTopic: "",
      appName: nombre,
      appTagline: String(b.appTagline || "Tu asistente personal, en casa y en tu bolsillo"),
      sessionMaxMb: 18,
      sessionCheckMinutes: 10,
    };

    try {
      // la carpeta puede no existir (p. ej. LUMI_CONFIG=/ruta/nueva/config.json)
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.mkdirSync(path.dirname(secretPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
      fs.writeFileSync(
        secretPath,
        JSON.stringify({ token, webPassword: pin }, null, 2) + "\n",
        { mode: 0o600 },
      );
      if (b.discord === false || !token) {
        log?.(
          "asistente: sin token de Discord — añade `LUMI_NO_DISCORD=1` al entorno o pon el token luego en secret.json",
        );
      }
      guardado = true;
      res.json({ ok: true, reinicio: bajoSupervisor() ? "supervisor" : "propio" });
      log?.("asistente: configuración guardada, reiniciando…");
      setTimeout(() => reiniciar(), 800);
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  const server = app.listen(port, host, () => {
    log?.(`primer arranque: abre http://localhost:${port} para configurar Lumi`);
  });

  return { server, guardado: () => guardado };
}

const PAGINA = `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lumi · primer arranque</title>
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
         background:radial-gradient(120% 90% at 50% 0%,#16131f,#0a0a0f 60%);
         color:#f6f5fa; font:15px/1.5 -apple-system,system-ui,Roboto,sans-serif }
  .caja { width:100%; max-width:460px; background:#12111a; border:1px solid #2a2538;
          border-radius:18px; padding:26px 24px; box-shadow:0 24px 60px rgba(0,0,0,.5) }
  h1 { margin:0 0 4px; font-size:22px; color:#a78bfa }
  p.sub { margin:0 0 22px; color:#8b8797; font-size:13.5px }
  label { display:block; margin:14px 0 6px; font-size:12.5px; color:#a9a5b6 }
  input { width:100%; padding:11px 13px; border-radius:11px; border:1px solid #322b45;
          background:#0e0d14; color:#f6f5fa; font-size:14.5px }
  input:focus { outline:2px solid #a78bfa55; border-color:#a78bfa }
  small { color:#5b5766; font-size:12px }
  button { width:100%; margin-top:24px; padding:13px; border:0; border-radius:12px;
           background:linear-gradient(180deg,#b9a6fd,#a78bfa); color:#0a0a0f;
           font-weight:700; font-size:15px; cursor:pointer }
  button:disabled { opacity:.4; cursor:default }
  .err { margin-top:14px; color:#ff8f8f; font-size:13px }
  .ok { margin-top:14px; color:#7ee0a1; font-size:13px }
</style></head><body>
<form class="caja" id="f">
  <h1><span data-t="titulo">Lumi · primer arranque</span></h1>
  <p class="sub" data-t="sub">Cuatro datos y listo. Puedes cambiarlo luego en Ajustes.</p>

  <label data-t="pin">PIN del panel (mínimo 4)</label>
  <input name="webPassword" type="password" autocomplete="new-password" required minlength="4" data-t-ph="pinPh" placeholder="algo que solo sepas tú">

  <label><span data-t="token">Token del bot de Discord</span> <small data-t="opcional">(opcional, si lo quieres en Discord)</small></label>
  <input name="token" placeholder="MTU2...">

  <label><span data-t="owner">Tu ID de Discord</span> <small data-t="ownerAyuda">(opcional, para que solo te haga caso a ti)</small></label>
  <input name="ownerIds" placeholder="123456789012345678">

  <label data-t="nombre">Nombre del asistente</label>
  <input name="appName" value="Lumi">

  <button id="b" type="submit" data-t="guardar">Guardar y arrancar</button>
  <div class="err" id="e"></div>
  <div class="ok" id="ok"></div>
</form>
<script>
const TEXTOS = {
  es: {
    titulo: "Lumi · primer arranque",
    sub: "Cuatro datos y listo. Puedes cambiarlo luego en Ajustes.",
    pin: "PIN del panel (mínimo 4)",
    pinPh: "algo que solo sepas tú",
    token: "Token del bot de Discord",
    opcional: "(opcional, si lo quieres en Discord)",
    owner: "Tu ID de Discord",
    ownerAyuda: "(opcional, para que solo te haga caso a ti)",
    nombre: "Nombre del asistente",
    guardar: "Guardar y arrancar",
    ok: "Guardado. Arrancando Lumi… recarga en unos segundos.",
    malo: "Dirección no válida",
  },
  en: {
    titulo: "Lumi · first run",
    sub: "Four fields and you're done. You can change it later in Settings.",
    pin: "Panel PIN (at least 4 characters)",
    pinPh: "something only you know",
    token: "Discord bot token",
    opcional: "(optional, if you want it on Discord)",
    owner: "Your Discord ID",
    ownerAyuda: "(optional, so it only answers to you)",
    nombre: "Assistant name",
    guardar: "Save and start",
    ok: "Saved. Restarting… reload in a few seconds.",
    malo: "Invalid address",
  },
};
const idioma = (navigator.language || "es").toLowerCase().startsWith("es") ? "es" : "en";
const T = TEXTOS[idioma];
document.documentElement.lang = idioma;
document.querySelectorAll("[data-t]").forEach((el) => {
  const k = el.dataset.t;
  if (T[k]) el.textContent = T[k];
});
document.querySelectorAll("[data-t-ph]").forEach((el) => {
  const k = el.dataset.tPh;
  if (T[k]) el.placeholder = T[k];
});

document.getElementById("f").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const b = document.getElementById("b"), e = document.getElementById("e"), ok = document.getElementById("ok");
  e.textContent = ""; ok.textContent = "";
  b.disabled = true;
  const datos = Object.fromEntries(new FormData(ev.target).entries());
  try {
    const r = await fetch("/api/setup", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(datos),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "error");
    ok.textContent = T.ok;
  } catch (err) {
    e.textContent = err.message;
    b.disabled = false;
  }
});
</script></body></html>`;
