import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

/**
 * Un AgentSession de pi por canal/conversación de Discord.
 *
 * La "clave" identifica la conversación. Para cada clave guardamos a qué
 * fichero de sesión de pi está enlazada (mapa persistente en links.json), de
 * modo que se puede enlazar un DM con la sesión principal de la terminal.
 */
/** Resume los argumentos de una herramienta a algo corto y legible. */
function resumirArgs(args) {
  try {
    if (!args || typeof args !== "object") return "";
    const clave =
      args.path ?? args.command ?? args.query ?? args.url ?? args.file ?? args.pattern ?? null;
    let texto = clave === null ? JSON.stringify(args) : String(clave);
    if (texto.length > 70) texto = texto.slice(0, 67) + "…";
    return texto;
  } catch {
    return "";
  }
}

export class SessionPool {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log;
    this.sessions = new Map(); // key -> { session, lastUsed }
    this.locks = new Map(); // key -> Promise
    this.ocupado = new Set(); // claves con un run en curso
    this.desde = new Map(); // clave -> timestamp de inicio del run
    this.linksFile = path.join(cfg.sessionDir, "links.json");
    this.links = this.#loadLinks();
    this.idleMs = 30 * 60 * 1000;
    this.timer = setInterval(() => this.sweep(), 5 * 60 * 1000);
    this.timer.unref?.();
  }

  #loadLinks() {
    try {
      return JSON.parse(fs.readFileSync(this.linksFile, "utf8"));
    } catch {
      return {};
    }
  }

  #saveLinks() {
    fs.writeFileSync(this.linksFile, JSON.stringify(this.links, null, 2), { mode: 0o600 });
  }

  keyFor(message) {
    if (!message.guildId) return `dm-${message.author.id}`;
    return `guild-${message.guildId}-channel-${message.channelId}`;
  }

  /** Fichero de sesión para una clave: enlace explícito o uno propio del canal. */
  sessionPathFor(key) {
    return this.links[key] ?? path.join(this.cfg.sessionDir, `${key}.jsonl`);
  }

  /** Enlaza una clave a un fichero de sesión de pi existente. */
  async link(key, sessionFile) {
    if (!fs.existsSync(sessionFile)) throw new Error(`No existe la sesión: ${sessionFile}`);
    await this.dispose(key);
    this.links[key] = sessionFile;
    this.#saveLinks();
    this.log(`enlazada ${key} -> ${sessionFile}`);
    return sessionFile;
  }

  async unlink(key) {
    await this.dispose(key);
    delete this.links[key];
    this.#saveLinks();
  }

  async get(key) {
    if (this.sessions.has(key)) {
      const entry = this.sessions.get(key);
      entry.lastUsed = Date.now();
      return entry.session;
    }

    const file = this.sessionPathFor(key);
    const sessionManager = fs.existsSync(file)
      ? SessionManager.open(file)
      : SessionManager.create(this.cfg.agentCwd, this.cfg.sessionDir);

    const opts = { cwd: this.cfg.agentCwd, sessionManager };
    if (this.cfg.model) opts.model = this.cfg.model;
    if (this.cfg.thinkingLevel) opts.thinkingLevel = this.cfg.thinkingLevel;

    const { session } = await createAgentSession(opts);
    // pi nombra los ficheros nuevos con timestamp: la ruta "prevista" no tiene
    // por qué ser la real. Guardamos la de verdad y la enlazamos, para que
    // /api/history la encuentre y para que un reinicio retome ESTA conversación.
    const realFile = sessionManager.getSessionFile?.() || session.sessionManager?.getSessionFile?.() || file;
    this.sessions.set(key, { session, lastUsed: Date.now(), file: realFile });
    if (realFile !== file) {
      this.links[key] = realFile;
      this.#saveLinks();
    }
    this.log(`sesión creada: ${key} -> ${path.basename(realFile)} (modelo ${session.model?.id ?? "default"})`);
    return session;
  }

  currentFile(key) {
    return this.sessions.get(key)?.file ?? this.sessionPathFor(key);
  }

  has(key) {
    return this.sessions.has(key);
  }

  /** Espera a que la sesión quede realmente inactiva (no solo un run). */
  #waitSettled(session, timeoutMs = 300000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe?.();
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "agent_settled") finish();
      });
    });
  }

  /** Recoge el texto del último turno escuchando message_end (autoritativo). */
  #collectTurn(session) {
    // Acumula TODO el texto del turno. Antes solo guardaba el último
    // message_end con texto, así que un turno que acababa en una llamada a
    // herramienta (o en un mensaje vacío) devolvía "" o una respuesta vieja.
    const state = { text: "", sawAssistant: false };

    const textoDe = (content) => {
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text)
          .join("");
      }
      return "";
    };

    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "message_end") return;
      const msg = event.message;
      if (msg?.role !== "assistant") return;
      state.sawAssistant = true;
      const t = textoDe(msg.content);
      // Se concatena: un turno puede tener varios mensajes assistant (texto,
      // luego tool call, luego más texto). Antes se perdía todo lo anterior.
      if (t.trim()) state.text += (state.text ? "\n" : "") + t;
    });
    return { state, unsubscribe };
  }

  /** Ejecuta un prompt en serie por sesión. Devuelve el texto del turno. */
  /** ¿Hay un run en curso? (sin bloquearse) */
  isBusy(key) {
    return this.ocupado.has(key);
  }

  /** Timestamp (ms) del inicio del run en curso, o null. */
  busySince(key) {
    return this.desde.get(key) ?? null;
  }

  /** Sesión ya creada, sin pasar por el lock (lectura rápida). */
  peek(key) {
    return this.sessions.get(key)?.session ?? null;
  }

  /**
   * Como peek() pero espera a que la sesión esté lista, creándola si hace falta.
   * Lo usa /api/stats: si peeks() devolviera null tras un reinicio, la UI
   * pintaría modelo/mensajes a null hasta el primer mensaje.
   */
  async ensure(key) {
    return this.get(key);
  }

  async run(key, text, onDelta, images, onEvent) {
    this.ocupado.add(key);
    this.desde.set(key, Date.now());
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      const session = await this.get(key);

      const { state, unsubscribe: unSub } = this.#collectTurn(session);
      let unDelta;
      if (onDelta) {
        unDelta = session.subscribe((event) => {
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent?.type === "text_delta"
          ) {
            onDelta(event.assistantMessageEvent.delta);
          }
        });
      }

      const settled = this.#waitSettled(session);
      try {
        if (images?.length) {
          await session.prompt(text, {
            images: images.map((im) => ({
              type: "image",
              data: im.data,
              mimeType: im.mimeType || "image/jpeg",
            })),
          });
        } else {
          await session.prompt(text);
        }
        // `prompt()` resuelve cuando el run acaba, pero puede haber trabajo
        // pendiente (retries, compactación). waitForIdle es la fuente fiable.
        if (typeof session.waitForIdle === "function") {
          // tope de seguridad: un run colgado no puede bloquear la sesión para siempre
          await Promise.race([
            session.waitForIdle(),
            new Promise((_, rej) =>
              setTimeout(() => rej(new Error("timeout esperando a que la sesión quede libre (10 min)")), 10 * 60 * 1000),
            ),
          ]);
        } else {
          await settled;
        }
      } finally {
        unSub();
        unDelta?.();
      }

      // Fallback: solo si el turno no produjo NADA de texto propio.
      // `getLastAssistantText()` devuelve el último assistant del historial
      // completo, no el de este turno: usarlo a lo bruto repetía respuestas
      // viejas o daba vacío. Solo se usa si no vimos ningún assistant nuevo.
      if (!state.sawAssistant) {
        state.text = session.getLastAssistantText() ?? "";
      }
      return state.text;
    });
    this.locks.set(
      key,
      next.catch(() => {}),
    );
    next
      .catch(() => {})
      .finally(() => {
        this.ocupado.delete(key);
        this.desde.delete(key);
      });
    return next;
  }

  /** Ejecuta con acceso a la sesión (para comandos que necesitan sus métodos). */
  async withSession(key, fn) {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(async () => fn(await this.get(key)));
    this.locks.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }

  async dispose(key) {
    const entry = this.sessions.get(key);
    if (!entry) return;
    try {
      entry.session.dispose();
    } catch {}
    this.sessions.delete(key);
  }

  /** Nueva conversación: desvincula el fichero actual y empieza limpio. */
  async newSession(key) {
    // El fichero real puede llamarse distinto que <key>.jsonl (pi usa
    // timestamps), así que archivamos el que de verdad está en uso.
    const real = this.sessions.get(key)?.file ?? this.sessionPathFor(key);
    await this.dispose(key);
    await this.unlink(key);
    try {
      fs.renameSync(real, `${real}.old-${Date.now()}`);
    } catch {}
    this.log(`nueva sesión para ${key} (archivada ${path.basename(real)})`);
  }

  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.sessions) {
      if (now - entry.lastUsed > this.idleMs && !this.locks.has(key)) {
        this.dispose(key);
        this.log(`sesión liberada por inactividad: ${key}`);
      }
    }
  }

  async disposeAll() {
    for (const key of [...this.sessions.keys()]) await this.dispose(key);
  }
}
