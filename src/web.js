import express from "express";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import multer from "multer";
import { transcribe } from "./transcribe.js";
import { extractSendBlocks, OUT_DIR } from "./media.js";
import { branding } from "./branding.js";
import { ROOT as ROOT_PROYECTO } from "./paths.js";
import {
  PI_BUILTINS,
  discoverDynamicCommands,
  listBotSessions,
  formatStats,
} from "./commands.js";
import { fileURLToPath } from "node:url";
import { tr } from "./i18n.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Servidor HTTP del dashboard. NO habla con pi directamente: delega todo en el
 * SessionPool que ya posee el bot. Así hay un único dueño de cada sesión.
 */
/**
 * Fichero de sesión que EXISTE de verdad.
 *
 * currentFile() devuelve la ruta "prevista" (<key>.jsonl), pero pi crea los
 * ficheros nuevos con nombre de timestamp. Cuando no coinciden, /api/history se
 * quedaba vacío y la web parecía borrar la conversación. Preguntamos también a
 * la sesión viva por su fichero real antes de darnos por vencidos.
 */
function realSessionFile(pool, key) {
  const candidatos = [];
  try {
    if (typeof pool.currentFile === "function") candidatos.push(pool.currentFile(key));
  } catch {}
  try {
    const s = pool.peek?.(key);
    candidatos.push(s?.getSessionStats?.()?.sessionFile);
  } catch {}
  for (const f of candidatos) if (f && fs.existsSync(f)) return f;
  return candidatos.find(Boolean) ?? null;
}

export function createWebServer({ cfg, pool, log, client, PI_BUILTINS }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "25mb" }));

  // --- cabeceras de seguridad -------------------------------------------
  // La web es de un solo usuario: no debe ser embebible por terceros, no debe
  // filtrar el Referer (llevaba rutas) y no ejecuta scripts externos.
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    res.set("X-Frame-Options", "SAMEORIGIN");
    res.set("Permissions-Policy", "geolocation=(), payment=(), usb=()");
    res.set(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        // el navegador en vivo va en otro puerto (4479/4480)
        "frame-src 'self' http: https:",
        "base-uri 'none'",
        "form-action 'self'",
        "object-src 'none'",
        "frame-ancestors 'self'",
      ].join("; "),
    );
    next();
  });

  const uploadDir = path.join(cfg.sessionDir, "..", "uploads");
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({ destination: uploadDir }),
    limits: { fileSize: 25 * 1024 * 1024 },
    // Solo imágenes: subir binarios arbitrarios a un servidor que después los
    // sirve en /files era una vía tonta de dejar un ejecutable a mano.
    fileFilter: (req, file, cb) => {
      const ok = /^image\/(jpeg|png|webp|gif|bmp|hei[cf])$/i.test(file.mimetype || "");
      cb(ok ? null : new Error("solo se aceptan imágenes"), ok);
    },
  });

  // ------------------------------------------------------------------
  // Tokens firmados (HMAC) en vez de un Map en memoria.
  // Antes el token vivía solo en RAM: cada `pm2 restart` invalidaba la sesión
  // y la web te echaba al login — eso es lo que se notaba como "pierde la
  // conexión". Con firma, el token sobrevive reinicios y dura 30 días.
  // ------------------------------------------------------------------
  const secreto =
    cfg.webSecret || crypto.createHash("sha256").update(String(cfg.webPassword) + "::valen").digest();
  const TTL_MS = 30 * 24 * 60 * 60 * 1000;

  function issueToken() {
    const exp = Date.now() + TTL_MS;
    const payload = String(exp);
    const sig = crypto.createHmac("sha256", secreto).update(payload).digest("base64url");
    return `${payload}.${sig}`;
  }

  function tokenValido(t) {
    if (typeof t !== "string") return false;
    const [payload, sig] = t.split(".");
    if (!payload || !sig) return false;
    const esperado = crypto.createHmac("sha256", secreto).update(payload).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(esperado);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const exp = Number(payload);
    return Number.isFinite(exp) && Date.now() < exp;
  }

  function auth(req, res, next) {
    const h = req.headers.authorization ?? "";
    // El token va en la cabecera Authorization. NO aceptamos `?token=` en las
    // rutas /api: los tokens en URLs acaban en logs, historiales e `Referer`.
    const t = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (tokenValido(t)) return next();
    res.status(401).json({ error: tr(req, "no autorizado") });
  }

  // --- freno de fuerza bruta en el login (por IP) --------------------------
  const intentos = new Map(); // ip -> { fallos, bloqueadaHasta }
  const MAX_FALLOS = 5;
  const BLOQUEO_MS = 15 * 60 * 1000;
  function loginBloqueado(ip) {
    const e = intentos.get(ip);
    if (!e) return 0;
    if (e.bloqueadaHasta && Date.now() < e.bloqueadaHasta) return e.bloqueadaHasta - Date.now();
    return 0;
  }
  function anotarFallo(ip) {
    const e = intentos.get(ip) ?? { fallos: 0, bloqueadaHasta: 0 };
    e.fallos += 1;
    if (e.fallos >= MAX_FALLOS) {
      e.fallos = 0;
      e.bloqueadaHasta = Date.now() + BLOQUEO_MS;
      log(`login web: ${ip} bloqueada 15 min por ${MAX_FALLOS} fallos`);
    }
    intentos.set(ip, e);
    if (intentos.size > 500) {
      for (const [k, v] of intentos) if (!v.bloqueadaHasta || Date.now() > v.bloqueadaHasta) intentos.delete(k);
    }
  }

  // --- login: solo el dueño, con el PIN de config (o el user id de Discord) ---
  // --- health: sin auth, para que la web distinga "cert" de "servidor caído" ---
  app.get("/api/health", (req, res) => {
    res.json({ ok: true, ts: Date.now(), uptime: Math.round(process.uptime()) });
  });

  app.post("/api/login", (req, res) => {
    const { password } = req.body ?? {};
    if (!cfg.webPassword) {
      return res.status(500).json({ error: tr(req, "falta webPassword en config.json") });
    }
    const ip = req.ip ?? "?";
    const espera = loginBloqueado(ip);
    if (espera > 0) {
      res.set("Retry-After", String(Math.ceil(espera / 1000)));
      return res.status(429).json({
        error: tr(req, "demasiados intentos", { n: Math.ceil(espera / 60000) }),
      });
    }
    const a = Buffer.from(String(password ?? ""));
    const b = Buffer.from(String(cfg.webPassword));
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      anotarFallo(ip);
      // Nunca loguear la contraseña ni un trozo: solo la longitud.
      log(`login web fallido desde ${ip} (${String(password ?? "").length} chars)`);
      return res.status(401).json({ error: tr(req, "contraseña incorrecta") });
    }
    intentos.delete(ip);
    res.set("Cache-Control", "no-store");
    res.json({ token: issueToken() });
  });

  const ownerKey = `dm-${cfg.ownerIds[0]}`;

  // --- estado / estadísticas ---
  app.get("/api/stats", auth, async (req, res) => {
    try {
      // Sin lock: si hay un run en curso, /api/stats NO debe esperar detrás
      // (antes se encolaba y tumbaba el servidor con el polling cada 7 s).
      // ensure() crea la sesión si aún no está en memoria; si no, tras un
      // reinicio el panel mostraría modelo/mensajes vacíos hasta el 1er mensaje.
      let session = pool.peek(ownerKey);
      if (!session) {
        session = await pool.ensure(ownerKey);
      }
      const out = {
        model: session?.model?.id ?? null,
        thinking: session?.thinkingLevel ?? null,
        streaming: pool.isBusy(ownerKey),
        tools: session?.getActiveToolNames?.() ?? [],
        file: realSessionFile(pool, ownerKey),
        messages: session?.state?.messages?.length ?? 0,
        busy: pool.isBusy(ownerKey),
        busySince: pool.busySince(ownerKey),
      };
      try {
        if (session && typeof session.getSessionStats === "function") {
          out.stats = await session.getSessionStats();
        }
      } catch (e) {
        out.statsError = e?.message;
      }

      const bots = client
        ? {
            tag: client.user?.tag,
            id: client.user?.id,
            ping: client.ws?.ping ?? null,
            guilds: client.guilds?.cache?.size ?? 0,
            uptime: Math.round((client.uptime ?? 0) / 1000),
          }
        : null;

      const mem = process.memoryUsage();
      const server = {
        ramMb: Math.round(mem.rss / 1048576),
        ramFree: Math.round(os.freemem() / 1048576),
        load: os.loadavg(),
        uptime: Math.round(process.uptime()),
      };
      res.set("Cache-Control", "no-store");
      res.json({
        // Campos planos (los usa `lumi status` y los scripts)
        ...out,
        discord: bots,
        server,
        // Lo que consume el panel web: { info, bots, sys }
        info: {
          model: out.model,
          thinking: out.thinking,
          messages: out.messages,
          tools: out.tools,
          file: out.file,
          streaming: out.streaming,
          stats: out.stats,
          statsError: out.statsError,
        },
        bots,
        sys: { ramFree: server.ramFree, load: server.load, uptime: server.uptime },
      });
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // --- actividad: resumen por días y por modelo -------------------------
  // El frontend la llama desde siempre (pestañas Resumen / Modelos) pero no
  // existía: express devolvía el HTML del 404, el cliente hacía res.json() y
  // saltaba "Unexpected token '<'" con todos los contadores a guiones.
  const cacheActividad = new Map(); // fichero -> { size, mtime, porDia }

  function leerSession(f) {
    const porDia = new Map(); // 'YYYY-MM-DD' -> { mensajes, tokens, coste, horas[24] }
    const modelos = new Map(); // modelo -> { mensajes, tokens, coste }
    let est;
    try {
      est = fs.statSync(f);
    } catch {
      return { porDia, modelos };
    }
    const previo = cacheActividad.get(f);
    if (previo && previo.size === est.size && previo.mtime === est.mtimeMs) {
      return { porDia: previo.porDia, modelos: previo.modelos };
    }

    let lineas = [];
    try {
      lineas = fs.readFileSync(f, "utf8").split("\n");
    } catch {
      return { porDia, modelos };
    }
    for (const linea of lineas) {
      if (!linea) continue;
      let e;
      try {
        e = JSON.parse(linea);
      } catch {
        continue;
      }
      if (e.type !== "message") continue;
      const m = e.message;
      if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
      // el timestamp puede venir como ISO ("2026-10-23T04:40:15.618Z") o en ms
      const bruto = e.timestamp ?? m.timestamp ?? 0;
      const ts = typeof bruto === "number" ? bruto : Date.parse(String(bruto));
      if (!ts || Number.isNaN(ts)) continue;
      const d = new Date(ts);
      const clave = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      let dia = porDia.get(clave);
      if (!dia) {
        dia = { mensajes: 0, tokens: 0, coste: 0, horas: new Array(24).fill(0), sesiones: 1 };
        porDia.set(clave, dia);
      }
      dia.mensajes += 1;
      dia.horas[d.getHours()] += 1;
      if (m.role !== "assistant") continue;
      const u = m.usage;
      const tokens = Number(u?.totalTokens ?? 0);
      const coste = Number(u?.cost?.total ?? 0);
      dia.tokens += tokens;
      dia.coste += coste;
      const nombre = m.model ?? "desconocido";
      const mod = modelos.get(nombre) ?? { mensajes: 0, tokens: 0, coste: 0 };
      mod.mensajes += 1;
      mod.tokens += tokens;
      mod.coste += coste;
      modelos.set(nombre, mod);
    }
    cacheActividad.set(f, { size: est.size, mtime: est.mtimeMs, porDia, modelos });
    return { porDia, modelos };
  }

  app.get("/api/activity", auth, (req, res) => {
    try {
      const dirs = [cfg.sessionDir, path.join(cfg.sessionDir, "_archivo")];
      const dias = new Map();
      const modelos = new Map();
      for (const dir of dirs) {
        let ficheros = [];
        try {
          ficheros = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
        } catch {
          continue;
        }
        for (const nombre of ficheros) {
          const { porDia, modelos: mods } = leerSession(path.join(dir, nombre));
          for (const [fecha, d] of porDia) {
            const acc = dias.get(fecha) ?? {
              date: fecha,
              sessions: 0,
              messages: 0,
              tokens: 0,
              cost: 0,
              hours: new Array(24).fill(0),
            };
            acc.sessions += 1; // un fichero con actividad ese día = una sesión
            acc.messages += d.mensajes;
            acc.tokens += d.tokens;
            acc.cost += d.coste;
            d.horas.forEach((v, i) => (acc.hours[i] += v));
            dias.set(fecha, acc);
          }
          for (const [nombre2, m] of mods) {
            const acc = modelos.get(nombre2) ?? { name: nombre2, messages: 0, tokens: 0, cost: 0 };
            acc.messages += m.mensajes;
            acc.tokens += m.tokens;
            acc.cost += m.coste;
            modelos.set(nombre2, acc);
          }
        }
      }
      res.set("Cache-Control", "no-store");
      res.json({
        days: [...dias.values()].sort((a, b) => a.date.localeCompare(b.date)),
        models: [...modelos.values()],
        generatedAt: Date.now(),
      });
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // --- cancelar la respuesta en curso -----------------------------------
  // Importante: NO usa withSession, porque eso espera al lock y el abort
  // llegaría cuando ya ha terminado. Se aborta la sesión viva si existe.
  app.post("/api/abort", auth, async (req, res) => {
    try {
      const s = pool.peek?.(ownerKey);
      if (!s) return res.json({ ok: true, nadaQueCancelar: true });
      if (typeof s.abort === "function") await s.abort();
      log?.("cancelado desde la web");
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // --- estado del run en curso (para reconectar desde el móvil) ---
  app.get("/api/state", auth, (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
      busy: pool.isBusy(ownerKey),
      since: pool.busySince(ownerKey),
      file: realSessionFile(pool, ownerKey),
    });
  });

  app.get("/api/history", auth, async (req, res) => {
    const limite = Math.min(Number(req.query.limit) || 300, 1000);
    try {
      const file = realSessionFile(pool, ownerKey);
      if (!file || !fs.existsSync(file)) {
        log?.(`history: sin fichero legible (${file ?? "ninguno"})`);
        return res.json({ messages: [] });
      }
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      const messages = [];
      for (const line of lines) {
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.type !== "message") continue;
        const m = e.message;
        if (!m) continue;
        let text = "";
        if (typeof m.content === "string") text = m.content;
        else if (Array.isArray(m.content))
          text = m.content
            .filter((c) => c?.type === "text")
            .map((c) => c.text)
            .join("");
        if (!text.trim()) continue;
        if (m.role === "user" || m.role === "assistant") {
          messages.push({ role: m.role, text, ts: e.timestamp });
        }
      }
      res.json({ messages: messages.slice(-limite), total: messages.length });
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // --- ajustes: leer y guardar configuración desde la web ---
  const rutaConfig = path.join(ROOT_PROYECTO, "config.json");
  const rutaSecret = path.join(ROOT_PROYECTO, "secret.json");
  const leerJson = (r) => {
    try {
      return JSON.parse(fs.readFileSync(r, "utf8"));
    } catch {
      return {};
    }
  };
  const escribirJson = (r, obj) => {
    fs.writeFileSync(r, JSON.stringify(obj, null, 2), { mode: 0o600 });
  };

  app.get("/api/settings", auth, (req, res) => {
    const c = leerJson(rutaConfig);
    const s = leerJson(rutaSecret);
    res.set("Cache-Control", "no-store");
    res.json({
      brand: { name: c.appName ?? branding.name, tagline: c.appTagline ?? branding.tagline },
      discord: {
        token: s.token ? `••••${String(s.token).slice(-4)}` : "",
        tokenSet: !!s.token,
        ownerIds: c.ownerIds ?? [],
        guildAllowlist: c.guildAllowlist ?? [],
        maxQueue: c.maxQueue ?? 5,
      },
      model: { thinkingLevel: c.thinkingLevel ?? "minimal", agentCwd: c.agentCwd ?? "~" },
      web: {
        webPort: c.webPort ?? 4477,
        webPortHttps: c.webPortHttps ?? 4478,
        https: !!c.webPortHttps,
      },
      voice: {
        enabled: c.voiceEnabled ?? false,
        device: c.castDevice ?? "",
        voice: c.castVoice ?? "es-ES-AlvaroNeural",
        mediaBase: c.mediaBase ?? "",
      },
      push: { ntfyTopic: c.ntfyTopic ?? "" },
      browser: { port: c.browserPort ?? 4479 },
      paths: { sessionDir: c.sessionDir ?? "", skillsDir: c.skillsDir ?? "" },
    });
  });

  app.post("/api/settings", auth, (req, res) => {
    const b = req.body ?? {};
    try {
      const c = leerJson(rutaConfig);
      const s = leerJson(rutaSecret);

      if (b.brand) {
        if (b.brand.name) c.appName = String(b.brand.name).slice(0, 40);
        if (b.brand.tagline !== undefined) c.appTagline = String(b.brand.tagline).slice(0, 120);
      }
      if (b.discord) {
        const t = b.discord.token?.trim();
        if (t && !t.startsWith("••••")) s.token = t;
        if (Array.isArray(b.discord.ownerIds)) {
          c.ownerIds = b.discord.ownerIds.map((x) => String(x).trim()).filter(Boolean);
        }
        if (Array.isArray(b.discord.guildAllowlist)) {
          c.guildAllowlist = b.discord.guildAllowlist.map((x) => String(x).trim()).filter(Boolean);
        }
        if (b.discord.maxQueue) c.maxQueue = Number(b.discord.maxQueue) || 5;
      }
      if (b.model) {
        if (b.model.thinkingLevel) c.thinkingLevel = String(b.model.thinkingLevel);
        if (b.model.agentCwd) c.agentCwd = String(b.model.agentCwd);
      }
      if (b.web) {
        if (b.web.webPort) c.webPort = Number(b.web.webPort);
        if (b.web.webPortHttps !== undefined) c.webPortHttps = Number(b.web.webPortHttps) || 0;
        // OJO: sólo tocamos el HTTPS si el formulario lo manda explícitamente.
        // Antes, un guardado sin la casilla lo ponía a 0 y la app del móvil se
        // quedaba fuera (el panel sólo escucha en http).
        if (b.web.https !== undefined) {
          c.webPortHttps = b.web.https ? Number(b.web.webPortHttps || c.webPortHttps || 4478) : 0;
        }
      }
      if (b.voice) {
        if (b.voice.enabled !== undefined) c.voiceEnabled = !!b.voice.enabled;
        if (b.voice.device !== undefined) c.castDevice = String(b.voice.device ?? "");
        if (b.voice.voice) c.castVoice = String(b.voice.voice);
        if (b.voice.mediaBase) c.mediaBase = String(b.voice.mediaBase);
      }
      if (b.push) c.ntfyTopic = String(b.push.ntfyTopic ?? "");
      if (b.browser?.port) c.browserPort = Number(b.browser.port);

      escribirJson(rutaConfig, c);
      escribirJson(rutaSecret, s);
      log("ajustes guardados desde la web");
      res.json({ ok: true, restart: true });
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // pruebas rápidas desde Ajustes
  app.post("/api/settings/test", auth, async (req, res) => {
    const { what } = req.body ?? {};
    try {
      if (what === "push") {
        const { notify } = await import("./notify.js");
        return res.json(await notify("Lumi", "Prueba de notificación desde Ajustes"));
      }
      if (what === "discord") {
        const ok = !!client?.isReady?.();
        return res.json({ ok, info: ok ? `Conectado como ${client.user?.tag}` : "Discord no conectado" });
      }
      if (what === "voice") {
        const c = leerJson(rutaConfig);
        const py = path.join(ROOT_PROYECTO, ".venv", "bin", "python");
        const { execFile } = await import("node:child_process");
        const args = [path.join(ROOT_PROYECTO, "scripts", "decir.py"), "--sin-sfx", "Prueba de voz de Lumi"];
        if (c.castDevice) args.unshift("--device", c.castDevice);
        return res.json(
          await new Promise((resolve) => {
            execFile(py, args, { timeout: 60000 }, (err, _out, errOut) =>
              resolve({ ok: !err, info: err ? String(errOut || err.message).slice(0, 200) : "enviado" }),
            );
          }),
        );
      }
      res.status(400).json({ error: tr(req, "prueba desconocida") });
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // --- URL del navegador en vivo, con token firmado ---------------------
  // Antes el iframe apuntaba directamente a :4479/:4480 sin auth y cualquiera
  // en la LAN podía manejar el Chromium (con tus sesiones abiertas).
  app.get("/api/browser-url", auth, (req, res) => {
    try {
      const dia = new Date().toISOString().slice(0, 10);
      const firma = crypto.createHmac("sha256", secreto).update(`browser:${dia}`).digest("hex");
      const https = req.query.https === "1" || req.protocol === "https";
      const host = (req.headers.host || "127.0.0.1").split(":")[0];
      const port = Number(cfg.browserPort ?? 4479) + (https ? 1 : 0);
      res.json({ url: `${https ? "https" : "http"}://${host}:${port}/?token=${firma}` });
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // --- branding (la web se rellena con esto) ---
  app.get("/api/branding", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({
      name: branding.name,
      short: branding.short,
      tagline: branding.tagline,
      description: branding.description,
      emoji: branding.emoji,
      colors: branding.colors,
      credits: branding.credits,
    });
  });

  // manifest de la PWA generado con el branding actual
  app.get("/manifest.webmanifest", (req, res) => {
    res.type("application/manifest+json");
    res.json({
      name: branding.name,
      short_name: branding.short,
      description: branding.description,
      start_url: "/",
      scope: "/",
      display: "standalone",
      orientation: "portrait",
      background_color: branding.colors.bg,
      theme_color: branding.colors.bg,
      lang: "es",
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    });
  });

  // --- ejecutar un comando de pi desde la web (mismos que en Discord) ---
  app.post("/api/command", auth, async (req, res) => {
    const { name, arg } = req.body ?? {};
    const valor = String(arg ?? "").trim();
    try {
      switch (name) {
        case "help": {
          const dyn = await discoverDynamicCommands(pool, ownerKey).catch(() => []);
          const built = PI_BUILTINS.map((c) => `**/${c.name}** — ${c.desc}`).join("\n");
          const skills = dyn.map((c) => `**${c.name}** — ${c.desc}`).join("\n") || "_ninguna_";
          return res.json({ text: `### Comandos\n${built}\n\n### Skills (con /run)\n${skills}` });
        }
        case "status": {
          const info = await pool.withSession(ownerKey, (s) => ({
            model: s.model?.id,
            thinking: s.thinkingLevel,
            tools: s.getActiveToolNames?.() ?? [],
            file: realSessionFile(pool, ownerKey),
            stats: typeof s.getSessionStats === "function" ? s.getSessionStats() : null,
          }));
          const stored = await listBotSessions(cfg.sessionDir);
          const lines = [
            `**Modelo:** \`${info.model ?? "default"}\``,
            `**Razonamiento:** \`${info.thinking ?? "—"}\``,
            `**Sesión:** \`${String(info.file).split("/").pop()}\``,
            `**Herramientas:** ${info.tools.length}`,
            `**Conversaciones guardadas:** ${stored.length}`,
          ];
          const f = formatStats(info.stats);
          if (f) lines.push("", f);
          return res.json({ text: lines.join("\n") });
        }
        case "new":
          await pool.newSession(ownerKey);
          return res.json({ text: "Contexto limpio. ¿Por dónde vamos?", clear: true });
        case "session":
        case "list": {
          const stored = await listBotSessions(cfg.sessionDir);
          const rows = stored
            .slice(0, 15)
            .map((s) => `\`${s.file}\` · ${new Date(s.mtime).toLocaleString("es-ES")}`);
          return res.json({ text: rows.join("\n") || "_sin sesiones_" });
        }
        case "model": {
          if (!valor) {
            const list = await pool.withSession(ownerKey, async (s) => {
              let models = [];
              try {
                models = (await s.modelRuntime?.getAvailableModels?.()) ?? [];
              } catch {}
              return {
                current: s.model?.id ?? "default",
                list: models.map((m) => `${m.provider}/${m.id}`),
              };
            });
            const shown = list.list.slice(0, 30).map((m) => `\`${m}\``).join("\n");
            return res.json({
              text: `Modelo actual: \`${list.current}\`\n\n${shown || "_no disponible_"}`,
            });
          }
          const changed = await pool.withSession(ownerKey, async (s) => {
            const models = (await s.modelRuntime?.getAvailableModels?.()) ?? [];
            const want = valor.replace(/^\//, "").toLowerCase();
            const m = models.find(
              (x) =>
                `${x.provider}/${x.id}`.toLowerCase() === want ||
                String(x.id).toLowerCase() === want,
            );
            if (!m) return null;
            await s.setModel(m);
            return m.id;
          });
          return res.json({
            text: changed
              ? `Modelo cambiado a \`${changed}\`.`
              : `No encuentro el modelo \`${valor}\`.`,
          });
        }
        case "thinking": {
          if (!valor) {
            const lvl = await pool.withSession(ownerKey, (s) => s.thinkingLevel ?? "—");
            return res.json({ text: `Razonamiento actual: \`${lvl}\`` });
          }
          const lvl = valor.toLowerCase();
          if (!["minimal", "low", "medium", "high", "max", "off"].includes(lvl)) {
            return res.json({ text: "Nivel no válido: minimal|low|medium|high|max" });
          }
          await pool.withSession(ownerKey, async (s) => s.setThinkingLevel?.(lvl));
          return res.json({ text: `Razonamiento: \`${lvl}\`` });
        }
        case "compact": {
          await pool.withSession(ownerKey, async (s) => s.compact?.(valor || undefined));
          return res.json({ text: "Contexto compactado." });
        }
        case "skills": {
          const dyn = await discoverDynamicCommands(pool, ownerKey).catch(() => []);
          return res.json({
            text: dyn.map((c) => `**${c.name}** — ${c.desc}`).join("\n") || "_ninguna_",
          });
        }
        case "abort":
          await pool.withSession(ownerKey, async (s) => s.abort?.());
          return res.json({ text: "Respuesta cancelada." });
        default:
          return res.json({ text: `Comando no disponible en la web: \`/${name}\`` });
      }
    } catch (e) {
      log("command error:", e?.stack || e);
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // --- comandos disponibles ---
  app.get("/api/commands", auth, (req, res) => {
    res.json({ builtins: PI_BUILTINS });
  });

  // --- chat con streaming (SSE) ---
  app.post("/api/chat", auth, async (req, res) => {
    const { text, images } = req.body ?? {};
    if (!text?.trim() && !(images?.length > 0)) {
      return res.status(400).json({ error: "texto vacío" });
    }

    // las cabeceras deben ir ANTES de flushHeaders (si no: ERR_HTTP_HEADERS_SENT)
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    res.socket?.setNoDelay?.(true);
    res.socket?.setKeepAlive?.(true, 15000);

    const send = (obj) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    let closed = false;
    const t0 = Date.now();
    let terminado = false;
    log(`chat: petición recibida (${(text || "").length} chars)`);

    // keep-alive: sin tráfico el móvil/proxy corta la conexión y salta "network error"
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 12000);
    res.on("close", () => {
      closed = true;
      clearInterval(ping);
      // si el cliente se va antes del done, queda registrado para diagnosticar
      if (!terminado) log(`chat: cliente cortó a los ${Date.now() - t0} ms (sin done)`);
    });

    try {
      const prompt = text?.trim() || "Describe la imagen.";
      const raw = await pool.run(
        ownerKey,
        prompt,
        (delta) => {
          if (!closed) send({ type: "delta", text: delta });
        },
        images,
        (ev) => {
          if (!closed) send({ type: "activity", ...ev });
        },
      );

      // bloques ```send``` -> archivos descargables desde la web
      const { text: reply, files } = extractSendBlocks(raw);
      if (files.length && !closed) {
        const pubFiles = path.join(__dirname, "..", "public", "files");
        fs.mkdirSync(pubFiles, { recursive: true });
        const served = [];
        for (const f of files) {
          try {
            const base = path.basename(f.path).replace(/[^\w.\-]+/g, "_");
            const name = `${crypto.randomBytes(8).toString("hex")}-${base}`;
            fs.copyFileSync(f.path, path.join(pubFiles, name));
            served.push({ name: base, url: `/files/${name}`, size: f.size });
          } catch (err) {
            log("copia de archivo falló:", err?.message || err);
          }
        }
        // limpia los servidos hace más de 6h
        try {
          const now = Date.now();
          for (const n of fs.readdirSync(pubFiles)) {
            const full = path.join(pubFiles, n);
            if (now - fs.statSync(full).mtimeMs > 6 * 3600_000) fs.unlinkSync(full);
          }
        } catch {}
        if (served.length) send({ type: "files", files: served });
      }
      if (!closed) send({ type: "done", text: reply });
      terminado = true;
      log(`chat: respuesta enviada en ${Date.now() - t0} ms`);
    } catch (e) {
      log("chat error:", e?.stack || e);
      if (!closed) send({ type: "error", error: String(e?.message ?? e) });
    } finally {
      clearInterval(ping);
      if (!res.writableEnded) res.end();
    }
  });

  // --- transcribir audio ---
  app.post("/api/transcribe", auth, upload.single("audio"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "sin audio" });
    const t0 = Date.now();
    try {
      log(`transcribiendo ${req.file.originalname} (${(req.file.size / 1024).toFixed(0)} KB)`);
      const r = await transcribe(req.file.path, { model: cfg.whisperModel ?? "base" });
      log(`transcrito en ${Date.now() - t0} ms: "${r.text.slice(0, 80)}"`);
      res.json({ ...r, ms: Date.now() - t0 });
    } catch (e) {
      log("transcribe error:", e?.message);
      res.status(500).json({ error: String(e?.message ?? e) });
    } finally {
      if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
    }
  });

  // --- subir imagen → devuelve base64 listo para prompt ---
  app.post("/api/upload", auth, upload.single("image"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: tr(req, "sin imagen") });
    try {
      const buf = fs.readFileSync(req.file.path);
      const mime = req.file.mimetype || "image/jpeg";
      res.json({
        data: buf.toString("base64"),
        mimeType: mime,
        size: req.file.size,
        name: req.file.originalname,
      });
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e) });
    } finally {
      fs.promises.unlink(req.file.path).catch(() => {});
    }
  });

  // --- reset de conversación ---
  // --- compactar contexto ---
  app.post("/api/compact", auth, async (req, res) => {
    try {
      const before = await pool.withSession(ownerKey, async (s) => ({
        messages: s.state?.messages?.length ?? 0,
        isCompacting: s.isCompacting ?? false,
      }));
      await pool.withSession(ownerKey, async (s) => {
        if (typeof s.compact !== "function") throw new Error("esta versión de pi no expone compact()");
        await s.compact(req.body?.instructions || undefined);
      });
      const after = await pool.withSession(ownerKey, async (s) => ({
        messages: s.state?.messages?.length ?? 0,
      }));
      log(`contexto compactado: ${before.messages} → ${after.messages} mensajes`);
      res.json({ ok: true, before: before.messages, after: after.messages });
    } catch (e) {
      log("compact error:", e?.message);
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  app.post("/api/new", auth, async (req, res) => {
    try {
      await pool.newSession(ownerKey);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e?.message ?? e) });
    }
  });

  // --- estáticos ---
  app.use(express.static(path.join(__dirname, "..", "public"), { etag: true, maxAge: 0 }));
  app.get("/", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(__dirname, "..", "public", "index.html"));
  });

  return app;
}
