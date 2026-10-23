import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  MessageFlags,
  REST,
  Routes,
} from "discord.js";
import { loadConfig, ensureDirs } from "./config.js";
import { SessionPool } from "./sessions.js";
import {
  downloadAttachments,
  transcribe,
  textToVoice,
  buildAttachmentContext,
  extractVoiceBlocks,
  extractSendBlocks,
  cleanupOut,
} from "./media.js";
import { createWebServer } from "./web.js";
import { startWizard } from "./wizard.js";
import { CERTS_DIR, ROOT as ROOT_PROYECTO } from "./paths.js";
import https from "node:https";
import path from "node:path";
import { readFileSync as readFileSyncFs, existsSync as existsSyncFs } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import {
  buildNativeCommands,
  discoverDynamicCommands,
  formatStats,
  listBotSessions,
  findPiSession,
  PI_BUILTINS,
} from "./commands.js";

const LOG_FILE = process.env.LUMI_LOG_FILE || "";
const log = (...a) => {
  const linea = [new Date().toISOString(), ...a].join(" ");
  console.log(linea);
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, linea + "\n", { mode: 0o600 });
    } catch {}
  }
};

// Primer arranque: sin config.json no hay nada que hacer, así que en vez de
// morir con un error se abre un formulario en el puerto del panel. Al guardar,
// el proceso sale y systemd/PM2/Docker lo vuelve a levantar ya configurado.
const RUTA_CONFIG = process.env.LUMI_CONFIG || path.join(ROOT_PROYECTO, "config.json");
if (!fs.existsSync(RUTA_CONFIG)) {
  startWizard({
    port: Number(process.env.WEB_PORT) || 4477,
    // rutas exactas: antes escribía siempre config.json/secret.json y con
    // LUMI_CONFIG a otro nombre el asistente volvía a salir en bucle
    configPath: RUTA_CONFIG,
    secretPath: process.env.LUMI_SECRET || path.join(ROOT_PROYECTO, "secret.json"),
    home: os.homedir(),
    log,
  });
  // el asistente termina con process.exit(0)
  await new Promise(() => {});
}

const cfg = loadConfig();
ensureDirs(cfg);

// Modo sólo-web: sin token de Discord (útil para pruebas y para quien quiera
// usar Lumi únicamente desde el navegador).   LUMI_NO_DISCORD=1 npm start
let SOLO_WEB = /^(1|true|si|sí|yes)$/i.test(process.env.LUMI_NO_DISCORD ?? "");

if (!cfg.token && !SOLO_WEB) {
  // Sin token no se puede conectar a Discord, pero el panel sí funciona: mejor
  // arrancar en modo sólo-web con un aviso claro que morir.
  log("sin token de Discord en secret.json → arranco sólo el panel web");
  SOLO_WEB = true;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const pool = new SessionPool(cfg, log);
if (Number(cfg.sessionMaxMb ?? 18) > 0) {
  log(`rotación de sesión: al pasar de ${cfg.sessionMaxMb ?? 18} MB (cada ${cfg.sessionCheckMinutes ?? 10} min)`);
}
const MAX = 1900;

function chunkText(text) {
  if (text.length <= MAX) return [text];
  const out = [];
  let rest = text;
  while (rest.length > MAX) {
    let cut = rest.lastIndexOf("\n", MAX);
    if (cut < MAX * 0.5) cut = rest.lastIndexOf(" ", MAX);
    if (cut < MAX * 0.5) cut = MAX;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.trim()) out.push(rest);
  return out;
}

function isOwner(id) {
  return cfg.ownerIds.includes(id);
}

function isAuthorized(message) {
  if (message.author.bot) return false;
  if (isOwner(message.author.id)) return true;
  if (message.guildId) {
    if (cfg.guildAllowlist.length && !cfg.guildAllowlist.includes(message.guildId)) return false;
    return client.user && message.mentions.has(client.user.id);
  }
  return false;
}

/** Ejecuta un prompt de pi con indicador de typing y troceado. */
async function runPrompt(message, key, text) {
  await message.channel.sendTyping().catch(() => {});
  const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
  typing.unref?.();
  try {
    const reply = await pool.run(key, text);
    return reply?.trim() || "(sin respuesta)";
  } finally {
    clearInterval(typing);
  }
}

async function reply(message, content) {
  // Bloques ```send``` -> archivos adjuntos
  const sent = extractSendBlocks(content ?? "");
  content = sent.text;
  // Bloques ```tts``` -> nota de voz
  const { text, audios } = extractVoiceBlocks(content ?? "");
  for (const part of chunkText(text)) {
    await message.reply({ content: part, allowedMentions: { repliedUser: false } });
  }
  for (const a of audios) await sendVoice(message, a);
  for (const f of sent.files) await sendFile(message, f.path);
}

/** Envía un archivo del disco como adjunto de Discord. */
async function sendFile(target, filePath) {
  const name = filePath.split("/").pop();
  try {
    await target.reply({
      content: "",
      files: [{ attachment: filePath, name }],
      allowedMentions: { repliedUser: false },
    });
  } catch (err) {
    log("envío de archivo falló:", err?.message || err);
    try {
      await target.channel?.send({ files: [{ attachment: filePath, name }] });
    } catch (e2) {
      log("envío de archivo (canal) falló:", e2?.message || e2);
    }
  }
}

/** Envía texto como nota de voz (ogg/opus). Si Discord la rechaza, cae a adjunto. */
async function sendVoice(target, text) {
  let file;
  try {
    file = await textToVoice(text);
  } catch (err) {
    log("TTS falló:", err?.message || err);
    return;
  }
  const attachment = { attachment: file.path, name: file.voice ? "valen.ogg" : "valen.mp3" };
  try {
    await target.reply({ files: [attachment], allowedMentions: { repliedUser: false } });
  } catch (err) {
    log("envío de audio falló:", err?.message || err);
    try {
      await target.channel.send({ files: [attachment] });
    } catch (e2) {
      log("envío de audio (canal) falló:", e2?.message || e2);
    }
  } finally {
    setTimeout(() => cleanupOut(), 5000)?.unref?.();
  }
}

/** Convierte los adjuntos de un mensaje en contexto textual para pi. */
async function attachmentsToContext(message) {
  const list = message.attachments;
  if (!list || list.size === 0) return "";
  const items = await downloadAttachments(list);
  const lines = buildAttachmentContext(items, log);
  const notes = [];

  for (const it of items) {
    if (it.kind === "audio" && it.path) {
      try {
        const t = await transcribe(it.path);
        if (t.text) notes.push(`[audio transcrito] ${t.text}`);
      } catch (err) {
        log("transcripción falló:", err?.message || err);
        notes.push(`[no pude transcribir ${it.name}]`);
      }
    }
  }

  const hasImage = items.some((i) => i.kind === "image" && i.path);
  const header = [
    "\ud83d\udcce Adjuntos (usar la herramienta read para verlos/leerlos):",
    ...lines,
    ...notes,
  ];
  if (hasImage) header.push("Hay imágenes: míralas con read antes de responder.");
  return "\n" + header.join("\n");
}

// ---------------------------------------------------------------- slash commands

async function registerSlashCommands() {
  const body = buildNativeCommands();
  const rest = new REST({ version: "10" }).setToken(cfg.token);
  await rest.put(Routes.applicationCommands(client.user.id), { body });
  log(`registrados ${body.length} slash commands globales`);
  // También por guild: aparecen al instante (los globales tardan ~1h en propagarse)
  for (const guild of client.guilds.cache.values()) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body });
      log(`registrados ${body.length} slash commands en guild ${guild.name}`);
    } catch (e) {
      log(`guild ${guild.id} falló:`, e?.message);
    }
  }
}

async function handleSlash(interaction) {
  const key = interaction.guildId
    ? `guild-${interaction.guildId}-channel-${interaction.channelId}`
    : `dm-${interaction.user.id}`;
  const name = interaction.commandName;

  // Autocompletado de /run
  if (interaction.isAutocomplete()) {
    if (name === "run") {
      const q = interaction.options.getFocused().toLowerCase();
      let choices = [];
      try {
        choices = await discoverDynamicCommands(pool, key);
      } catch {}
      const filtered = choices
        .filter((c) => c.name.toLowerCase().includes(q))
        .slice(0, 25)
        .map((c) => ({ name: c.name.slice(0, 100), value: c.name }));
      await interaction.respond(filtered);
    }
    return;
  }

  if (!isOwner(interaction.user.id) && !interaction.guildId) {
    return interaction.reply({ content: "No autorizado.", flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply();
  const valor = interaction.options.getString?.("valor") ?? "";
  const texto = interaction.options.getString?.("texto") ?? "";
  let out;

  try {
    switch (name) {
      case "help": {
        const dyn = await discoverDynamicCommands(pool, key).catch(() => []);
        const built = PI_BUILTINS.map((c) => `\`/${c.name}\` — ${c.desc}`).join("\n");
        const skills = dyn.map((c) => `\`${c.name}\` — ${c.desc}`).join("\n") || "_ninguna_";
        out = `**Comandos**\n${built}\n\n**Skills** (usar con \`/run\`)\n${skills}`;
        break;
      }

      case "status": {
        const info = await pool.withSession(key, (s) => ({
          model: s.model?.id,
          file: pool.currentFile(key),
          tools: s.getActiveToolNames?.() ?? [],
        }));
        const stored = await listBotSessions(cfg.sessionDir);
        out = [
          `**Modelo:** \`${info.model ?? "default"}\``,
          `**Sesión:** \`${info.file.split("/").pop()}\``,
          `**Herramientas:** ${info.tools.join(", ") || "ninguna"}`,
          `**Conversaciones guardadas:** ${stored.length}`,
          `**Cwd:** \`${cfg.agentCwd}\``,
        ].join("\n");
        break;
      }

      case "new":
        await pool.newSession(key);
        out = "Conversación nueva. Contexto limpio.";
        break;

      case "name": {
        const newName = valor?.trim();
        if (!newName) {
          const f = pool.currentFile(key).split("/").pop();
          out = `Nombre actual: \`${f}\``;
        } else {
          await pool.withSession(key, async (s) => {
            if (typeof s.setSessionName === "function") await s.setSessionName(newName);
          });
          out = `Sesión nombrada: **${newName}**`;
        }
        break;
      }

      case "model": {
        if (!valor) {
          const mr = pool.sessions.get(key)?.session?.modelRuntime;
          let list = [];
          try {
            list = (await mr?.getAvailableModels?.()) ?? [];
          } catch {}
          const shown = list.slice(0, 30).map((m) => `\`${m.provider}/${m.id}\``).join("\n");
          out = `Modelo actual: \`${pool.sessions.get(key)?.session?.model?.id ?? "default"}\`\n\n${shown || "_no disponible_"}`;
        } else {
          out = await runPrompt(interaction, key, `/model ${valor}`);
        }
        break;
      }

      case "thinking":
        out = await runPrompt(interaction, key, valor ? `/thinking ${valor}` : `/thinking`);
        break;

      case "compact":
        out = await runPrompt(interaction, key, valor ? `/compact ${valor}` : "/compact");
        break;

      case "session":
        out = await runPrompt(interaction, key, "/session");
        break;

      case "list": {
        const stored = await listBotSessions(cfg.sessionDir);
        out =
          stored
            .slice(0, 20)
            .map((s) => `\`${s.file}\` · ${(s.size / 1024).toFixed(0)} KB · ${s.mtime.toISOString().slice(0, 16)}`)
            .join("\n") || "_sin sesiones_";
        break;
      }

      case "resume": {
        if (!valor.trim()) {
          const lista = await pool.listSessions(key, 12);
          if (!lista.length) {
            out = "_no hay sesiones guardadas_";
            break;
          }
          out =
            "**Sesiones recientes**\n" +
            lista
              .map((s, i) => {
                const fecha = (s.modificada ?? "").slice(0, 16).replace("T", " ");
                const nombre = s.name ? `**${s.name}** · ` : "";
                const extra = `${s.archivada ? " · archivada" : ""}${s.actual ? " · actual" : ""}`;
                const preview = (s.preview || "_vacía_").slice(0, 90);
                return `**${i + 1}.** ${nombre}\`${fecha}\` · ${s.mensajes} msgs${extra}\n   ${preview}`;
              })
              .join("\n") +
            "\n\nRetomar con `/resume <número>` o `/resume <id>`";
        } else {
          const s = await pool.resume(key, valor);
          out = `Retomada \`${s.file}\`${s.mensajes ? ` · ${s.mensajes} mensajes` : ""}. Contexto cargado.`;
        }
        break;
      }

      case "link": {
        const found = await findPiSession(valor.trim());
        if (!found) {
          out = `No encuentro la sesión \`${valor}\`. Prueba con \`/list\` o el nombre de fichero.`;
        } else {
          await pool.link(key, found.path);
          out = `Enlazado a \`${found.path.split("/").pop()}\`. Ahora compartimos conversación.`;
        }
        break;
      }

      case "linkmain": {
        const mainFile = process.env.PI_SESSION_FILE;
        if (!mainFile) {
          out = "No tengo configurada la sesión principal. Usa `/link` con el ID.";
        } else {
          await pool.link(key, mainFile);
          out = `Enlazado a la sesión principal:\n\`${mainFile.split("/").pop()}\``;
        }
        break;
      }

      case "skills": {
        const dyn = await discoverDynamicCommands(pool, key);
        out = dyn.map((c) => `\`${c.name}\` — ${c.desc}`).join("\n") || "_ninguna skill_";
        break;
      }

      case "reload":
        out = await runPrompt(interaction, key, "/reload");
        break;

      case "abort": {
        await pool.withSession(key, async (s) => {
          if (typeof s.abort === "function") await s.abort();
        });
        out = "Cancelado.";
        break;
      }

      case "run": {
        const target = valor.startsWith("/") ? valor : `/${valor}`;
        out = await runPrompt(interaction, key, texto ? `${target} ${texto}` : target);
        break;
      }

      case "tts": {
        const t = valor?.trim();
        if (!t) {
          out = "Uso: `/tts <texto>`";
          break;
        }
        await sendVoice(
          { reply: (o) => interaction.followUp(o), channel: interaction.channel },
          t,
        );
        out = "🔊 Audio enviado.";
        break;
      }

      default:
        out = `Comando desconocido: ${name}`;
    }
  } catch (err) {
    log("ERROR slash:", err?.stack || err);
    out = `Error: \`${String(err?.message ?? err).slice(0, 400)}\``;
  }

  const parts = chunkText(out);
  await interaction.editReply(parts[0]);
  for (const p of parts.slice(1)) await interaction.followUp(p);
}

// ---------------------------------------------------------------- comandos por texto (!comando)
// Fallback para cuando el cliente de Discord no muestra los slash commands.

function makeTextInteraction(message, key, name, arg) {
  const parts = [];
  return {
    commandName: name,
    user: message.author,
    guildId: message.guildId ?? null,
    channelId: message.channelId,
    channel: message.channel,
    isAutocomplete: () => false,
    options: {
      getString: (k) => (k === "valor" || k === "nombre" ? arg ?? null : null),
      getFocused: () => "",
    },
    deferReply: async () => {},
    editReply: async (content) => {
      parts.push(content);
      await message.reply({ content, allowedMentions: { repliedUser: false } });
    },
    followUp: async (content) => {
      await message.reply({ content, allowedMentions: { repliedUser: false } });
    },
    reply: async (opts) => {
      const content = typeof opts === "string" ? opts : opts?.content;
      if (content) await message.reply({ content, allowedMentions: { repliedUser: false } });
    },
  };
}

const TEXT_CMD_PREFIX = /^[!./]([a-z]+)\s*([\s\S]*)$/i;

async function tryTextCommand(message, key, text) {
  const m = text.match(TEXT_CMD_PREFIX);
  if (!m) return false;
  const name = m[1].toLowerCase();
  if (!PI_BUILTINS.some((c) => c.name === name)) return false;
  const shim = makeTextInteraction(message, key, name, m[2].trim());
  await handleSlash(shim);
  return true;
}

// ---------------------------------------------------------------- mensajes normales

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;

    if (!isAuthorized(message)) return;

    let text = message.content;
    if (client.user) text = text.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim();
    if (!text && message.attachments.size === 0) return;

    const key = pool.keyFor(message);
    if (text && (await tryTextCommand(message, key, text))) return;

    const ctx = await attachmentsToContext(message);
    if (ctx && !text) text = "Mira esto y dime qué ves.";
    if (!text && !ctx) return;

    await reply(message, await runPrompt(message, key, text + ctx));
  } catch (err) {
    log("ERROR msg:", err?.stack || err?.message || err);
    try {
      await message.reply(`Error: \`${String(err?.message ?? err).slice(0, 300)}\``);
    } catch {}
  }
});

// ---------------------------------------------------------------- arranque

async function arrancar(c) {
  if (c) {
    log(`Conectado como ${c.user.tag} (${c.user.id})`);
    log(`Dueños autorizados: ${cfg.ownerIds.join(", ")}`);
    c.user.setPresence({ activities: [{ name: cfg.appName ?? "Lumi", type: 3 }], status: "online" });
    try {
      await registerSlashCommands();
    } catch (e) {
      log("No pude registrar slash commands:", e?.message);
    }
  } else {
    log("modo sólo-web (sin Discord)");
    log(`Dueños autorizados: ${cfg.ownerIds.join(", ")}`);
  }

  // Dashboard web (mismo proceso → mismo dueño de las sesiones)
  if (cfg.webPort) {
    try {
      // Precarga la sesión del dueño para que /api/stats tenga datos desde el
      // primer segundo (antes, tras cada reinicio, el panel salía vacío).
      const ownerKey = cfg.ownerKey;
      try {
        const s = await pool.ensure(ownerKey);
        log(`sesión principal precargada: ${s.state?.messages?.length ?? 0} mensajes`);
      } catch (e) {
        log("no pude precargar la sesión:", e?.message);
      }

      const app = createWebServer({ cfg, pool, log, client, PI_BUILTINS });
      const server = app.listen(cfg.webPort, "0.0.0.0", () => {
        log(`dashboard en http://0.0.0.0:${cfg.webPort}`);
      });
      // Node cierra los sockets ociosos a los 5 s por defecto. En el móvil eso
      // deja sockets "medio muertos" en el navegador: al volver tras un rato,
      // el primer POST reusa uno ya cerrado y falla sin llegar al servidor
      // (lo que se ve como "se cortó la conexión"). Los alargamos.
      const afinar = (s) => {
        if (!s) return s;
        s.keepAliveTimeout = 65_000;
        s.headersTimeout = 70_000;
        return s;
      };
      afinar(server);
      // HTTPS (necesario para micrófono/PWA en móvil) — mismo express, otro puerto
      const httpsPort = cfg.webPortHttps ?? 4478;
      // Preferimos el certificado REAL de Tailscale (certs-tls/, Let's Encrypt):
      // sin avisos en el móvil y con nombre estable aunque cambie la IP.
      // Si no existe, caemos al autofirmado de certs/.
      const elegirPar = () => {
        const candidatos = [
          path.join(ROOT_PROYECTO, "certs-tls"),
          CERTS_DIR,
        ];
        for (const dir of candidatos) {
          const c = path.join(dir, "cert.pem");
          const k = path.join(dir, "key.pem");
          if (existsSyncFs(c) && existsSyncFs(k)) return { dir, cert: c, key: k };
        }
        return null;
      };
      const par = elegirPar();
      if (httpsPort && par) {
        try {
          const tlsApp = createWebServer({ cfg, pool, log, client, PI_BUILTINS });
          const tlsServer = https.createServer(
            { cert: readFileSyncFs(par.cert), key: readFileSyncFs(par.key) },
            tlsApp,
          );
          afinar(tlsServer);
          tlsServer.listen(httpsPort, "0.0.0.0", () => {
            log(`dashboard seguro en https://0.0.0.0:${httpsPort} (cert ${par.dir})`);
          });
          tlsServer.on("error", (e) => log("dashboard https error:", e?.message));
        } catch (e) {
          log("dashboard https falló:", e?.message);
        }
      } else if (httpsPort) {
        log(`dashboard https: sin certificados en ${path.join(ROOT_PROYECTO, "certs-tls")} ni ${CERTS_DIR}`);
      }

      server.on("error", (e) => {
        if (e?.code === "EADDRINUSE") {
          log(`dashboard: puerto ${cfg.webPort} ocupado — reintento en 3s`);
          setTimeout(() => {
            try {
              server.close();
              const s2 = afinar(
                createWebServer({ cfg, pool, log, client, PI_BUILTINS }).listen(
                  cfg.webPort,
                  "0.0.0.0",
                ),
              );
              s2.on("error", (e2) => log("dashboard reintento falló:", e2?.message));
            } catch (e2) {
              log("dashboard reintento falló:", e2?.message);
            }
          }, 3000);
        } else {
          log("dashboard error:", e?.message);
        }
      });
    } catch (e) {
      log("dashboard falló:", e?.message);
    }
  }
}

client.once(Events.ClientReady, (c) => {
  arrancar(c).catch((e) => log("arranque:", e?.stack || e));
});

client.on(Events.InteractionCreate, (i) => {
  if (i.isChatInputCommand() || i.isAutocomplete()) {
    log(
      `interacción: /${i.commandName}${i.isAutocomplete() ? " (autocomplete)" : ""} de ${i.user?.tag ?? i.user?.id}`,
    );
    handleSlash(i).catch((e) => log("slash:", e));
  }
});

client.on(Events.Error, (e) => log("client error:", e?.message));
process.on("unhandledRejection", (e) => log("unhandledRejection:", e?.stack || e));

let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Apagando (${sig})...`);
  // Damos margen a que el turno en curso termine antes de destruir la sesión.
  try {
    await Promise.race([
      pool.disposeAll(),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
  } catch {}
  try {
    await client.destroy();
  } catch {}
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Nunca morir por una promesa suelta: el bot debe seguir vivo.
process.on("uncaughtException", (e) => {
  log("uncaughtException:", e?.stack || e?.message || e);
});

if (SOLO_WEB) {
  arrancar(null).catch((e) => log("arranque:", e?.stack || e));
} else {
  client.login(cfg.token).catch((e) => {
    log("Login falló:", e?.message || e);
    process.exit(1);
  });
}
