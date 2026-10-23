import { t, aplicar, ponerIdioma, idiomaActual, IDIOMAS } from "/i18n.js?v=2";

const $ = (id) => document.getElementById(id);

/* Botón de emergencia: /?reset=1 borra el service worker y las cachés del
   navegador y vuelve a cargar. Para cuando el móvil se queda con una versión
   vieja pegada y no hay forma de sacarlo de ahí. */
if (new URL(location.href).searchParams.has("reset")) {
  (async () => {
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
      await Promise.all(regs.map((r) => r.unregister()));
      const claves = (await caches?.keys?.()) ?? [];
      await Promise.all(claves.map((k) => caches.delete(k)));
    } catch {}
    sessionStorage.clear();
    location.replace("/");
  })();
}
const TOKEN_KEY = "valen.token";

let token = localStorage.getItem(TOKEN_KEY) || "";
let busy = false;
let statsTimer = null;

/* ---------------- utilitarios ---------------- */

const fmtNum = (n) =>
  n == null ? "—" : n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n);

const fmtBytes = (b) => {
  if (!b) return "—";
  const gb = b / 1024 ** 3;
  return gb >= 1 ? gb.toFixed(1) + " GB" : (b / 1024 ** 2).toFixed(0) + " MB";
};

const fmtUptime = (s) => {
  if (s == null) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
};

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Markdown mínimo: bloques ```, `código`, **negrita**, *cursiva*. */
function render(text) {
  let html = esc(text);
  // bloques ```send``` -> tarjetas de archivo (nunca como código en bruto)
  html = html.replace(/```(?:send|file|files|enviar|adjuntar)[^\n]*\n([\s\S]*?)```/g, (_, body) => {
    const chips = body
      .split("\n")
      .map((l) => l.trim().replace(/^[-*]\s*/, ""))
      .filter(Boolean)
      .map((ruta) => {
        const pub = ruta.replace(/^\/home\/leon\/valen-bot\/public/, "");
        const nombre = ruta.split("/").pop();
        if (pub !== ruta) {
          return `<a class="files__item" href="${pub}" target="_blank" rel="noopener"><span class="files__ext">FILE</span><span class="files__meta"><b>${nombre}</b><small>archivo</small></span></a>`;
        }
        return `<span class="files__meta"><b>${nombre}</b><small>${ruta}</small></span>`;
      })
      .join("");
    return chips ? `<div class="files">${chips}</div>` : "";
  });
  html = html.replace(/```([\s\S]*?)```/g, (_, c) => `<pre><code>${esc(c.trim())}</code></pre>`);
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  html = html.replace(/(^|\s)\*([^*\n]+)\*/g, "$1<i>$2</i>");
  return html;
}

/* ---------------- API ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    logout();
    throw new Error("sesión caducada");
  }
  return res;
}

/* ---------------- aviso de red ---------------- */
function aviso(msg) {
  const b = $("netBanner");
  if (!b) return;
  if (!msg) { b.classList.add("hidden"); return; }
  $("netMsg").innerHTML = msg;
  b.classList.remove("hidden");
}

/** Prueba si el fallo es del certificado (https) o del servidor. */
async function diagnosticar() {
  const esHttps = location.protocol === "https:";
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    if (r.ok) return "servidor-ok";
  } catch {}
  if (esHttps) {
    return "cert";
  }
  return "servidor-caido";
}

/* ---------------- login ---------------- */

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = $("pass").value;
  $("loginErr").textContent = "";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "error");
    token = data.token;
    localStorage.setItem(TOKEN_KEY, token);
    start();
  } catch (err) {
    $("loginErr").textContent = err.message;
  }
});

function logout() {
  token = "";
  localStorage.removeItem(TOKEN_KEY);
  clearInterval(statsTimer);
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
  $("pass").value = "";
}

$("logoutBtn").addEventListener("click", logout);

/* ---------------- chat ---------------- */

function addMsg(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.innerHTML = `
    <div class="msg__who">${role === "user" ? "TÚ" : "V"}</div>
    <div class="msg__body">${render(text)}</div>`;
  $("msgs").appendChild(el);
  scrollDown();
  return el.querySelector(".msg__body");
}

function scrollDown() {
  const m = $("msgs");
  m.scrollTop = m.scrollHeight;
}

/**
 * Repinta la conversación desde el servidor.
 *
 * OJO: el servidor escribe el turno en el JSONL al TERMINAR, así que justo
 * después de una respuesta el historial puede venir con menos mensajes de los
 * que hay en pantalla. Antes eso borraba la respuesta recién llegada; ahora no
 * se permite "encoger" la conversación salvo que se pida a propósito (force).
 */
async function loadHistory(force = false) {
  try {
    const res = await api("/api/history?limit=300");
    const { messages } = await res.json();
    const enPantalla = document.querySelectorAll("#msgs .msg").length;
    if (!force && messages.length < enPantalla && enPantalla > 0) return;
    $("msgs").innerHTML = "";
    if (!messages.length) {
      addMsg("assistant", t("Hola. Aquí estoy, desde el navegador."));
      return;
    }
    for (const m of messages) addMsg(m.role, m.text);
  } catch (e) {
    // Nunca dejar la conversación en blanco sin explicación: si falla, se dice
    // y se ofrece reintentar (antes el área se quedaba vacía y parecía roto).
    if (!force && document.querySelector("#msgs .msg")) return;
    const cuerpo = addMsg("assistant", "");
    cuerpo.innerHTML =
      render("⚠️ " + t("No pude cargar la conversación") + ".") +
      `<div class="netwarn"><button type="button" class="netwarn__retry">${t("Reintentar")}</button></div>`;
    cuerpo.querySelector(".netwarn__retry")?.addEventListener("click", () => loadHistory(true));
  }
}

let lastSent = "";

/**
 * Abre el stream de /api/chat. Si el móvil estuvo suspendido, la primera
 * petición puede reutilizar un socket que el servidor ya cerró (keep-alive) y
 * falla al instante con "network error": reintentamos una vez en silencio
 * antes de enseñar el aviso de conexión cortada.
 */
async function abrirChat(text, imgs) {
  const payload = JSON.stringify({
    text,
    images: imgs.map((i) => ({ data: i.data, mimeType: i.mimeType })),
  });
  const pedir = () =>
    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: payload,
    });
  try {
    return await pedir();
  } catch (err) {
    if (!/network|failed to fetch|load failed|networkerror|load failed/i.test(err.message || "")) throw err;
    await new Promise((r) => setTimeout(r, 700));
    return await pedir();
  }
}

/* ---------------- botón enviar / cancelar ---------------- */
// Mientras hay una respuesta en marcha el botón deja de ser "enviar" y pasa a
// ser un cuadrado de cancelar (como ChatGPT/Gemini). También aparece así al
// volver a la app si el servidor sigue trabajando.
const SVG_ENVIAR =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>';
const SVG_CANCELAR =
  '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2.2"/></svg>';

function modoEscribir() {
  const b = $("sendBtn");
  if (!b) return;
  b.classList.remove("is-cancel");
  if (b.innerHTML !== SVG_ENVIAR) b.innerHTML = SVG_ENVIAR;
  b.disabled = false;
  b.title = "Enviar";
  b.setAttribute("aria-label", "Enviar");
}

function modoCancelar() {
  const b = $("sendBtn");
  if (!b) return;
  b.classList.add("is-cancel");
  if (b.innerHTML !== SVG_CANCELAR) b.innerHTML = SVG_CANCELAR;
  b.disabled = false;
  b.title = "Cancelar";
  b.setAttribute("aria-label", "Cancelar");
}

/** Corta lo que estoy haciendo ahora mismo. */
async function cancelar() {
  modoEscribir();
  clearInterval(reanudando);
  $("topSub").textContent = t("Cancelando…");
  try {
    await api("/api/abort", { method: "POST" });
  } catch (e) {
    $("topSub").textContent = t("No pude cancelar");
  }
  // Esperamos a que el servidor suelte el run antes de repintar el historial
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const st = await estadoServidor();
    if (!st.busy) break;
  }
  busy = false;
  quitarBurbujaPendiente();
  // aquí sí puede encoger: lo que se estaba escribiendo se ha descartado
  await loadHistory(true);
  scrollDown();
  refreshStats();
  $("topSub").textContent = t("Cancelado");
  setTimeout(() => {
    if (!busy && $("topSub").textContent === t("Cancelado")) $("topSub").textContent = t("Conectado");
  }, 2500);
}

async function send(text, skipUserEcho = false) {
  const imgs = pendingImages.slice();
  if (busy || (!text.trim() && !imgs.length)) return;
  busy = true;
  modoCancelar();

  // Mensaje del usuario (con miniaturas si hay imágenes)
  const userBody = addMsg("user", text || (imgs.length ? "🖼 Imagen" : ""));
  if (imgs.length) {
    userBody.innerHTML =
      imgs.map((im) => `<img src="data:${im.mimeType};base64,${im.data}" alt="">`).join("") +
      (text ? render(text) : "");
  }

  pendingImages = [];
  renderAttach();

  const body = addMsg("assistant", "");
  body.parentElement?.classList.add("streaming");

  // si ya había una respuesta en curso (otra pestaña, o cerraste la app a mitad),
  // avisamos en vez de dejar el mensaje en cola sin explicación
  const st = await estadoServidor().catch(() => ({ busy: false }));
  if (st.busy) {
    $("topSub").textContent = t("En cola: esperando a que termine la respuesta anterior…");
  }
  body.classList.add("cursor");

  try {
    const res = await abrirChat(text, imgs);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    lastSent = text;
    let buf = "";
    let acc = "";
    let files = [];
    let gotDone = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (ev.type === "activity") {
          /* pasos internos: no se muestran (hay iframe del navegador) */
        } else if (ev.type === "delta") {
          acc += ev.text;
          body.innerHTML = render(acc);
          scrollDown();
        } else if (ev.type === "files") {
          files = ev.files || [];
        } else if (ev.type === "done") {
          gotDone = true;
          acc = ev.text || acc;
          body.innerHTML = render(acc || "_(sin respuesta)_");
          if (files.length) body.insertAdjacentHTML("beforeend", renderFiles(files));
        } else if (ev.type === "error") {
          body.innerHTML = render("⚠️ " + ev.error);
        }
      }
    }
    if (!acc) body.innerHTML = render("_(sin respuesta)_");
  } catch (err) {
    const red = /network|failed to fetch|load failed|networkerror/i.test(err.message || "");
    if (red && acc) {
      // se cortó a mitad: mostramos lo recibido y ofrecemos reintentar
      body.innerHTML =
        render(acc) +
        `<div class="netwarn">Conexión cortada a mitad de respuesta. <button type="button" class="netwarn__retry">Reintentar</button></div>`;
      body.querySelector(".netwarn__retry")?.addEventListener("click", () => send(lastSent, true));
    } else if (red) {
      body.innerHTML =
        render("⚠️ Se cortó la conexión (wifi/datos o el bot se reinició).") +
        `<div class="netwarn"><button type="button" class="netwarn__retry">Reintentar</button></div>`;
      body.querySelector(".netwarn__retry")?.addEventListener("click", () => send(lastSent, true));
    } else {
      body.innerHTML = render("⚠️ " + err.message);
    }
  } finally {
    body.parentElement?.classList.remove("streaming");
    body.classList.remove("cursor");
    busy = false;
    modoEscribir();
    $("topSub").textContent = t("Conectado");

    // el móvil a veces corta el stream antes del "done": pedimos la verdad al servidor
    if (!gotDone) {
      setTimeout(async () => {
        if (busy) return;
        await loadHistory();
        scrollDown();
      }, 900);
    }
    refreshStats();
  }
}


/** Tarjetas de archivos enviados por Valen. */
function renderFiles(files) {
  const IMG = /\.(png|jpe?g|webp|gif|bmp)$/i;
  const AUD = /\.(ogg|oga|mp3|wav|m4a|opus|flac|aac|webm)$/i;
  const VID = /\.(mp4|mov|mkv)$/i;
  // en https (app/cert propio) las descargas van por http, que Chrome no bloquea
  const base = location.protocol === "https:" ? `http://${location.hostname}:4477` : "";
  return `<div class="files">${files
    .map((f) => {
      const kb = f.size ? Math.max(1, Math.round(f.size / 1024)) : 0;
      const url = f.url.startsWith("http") ? f.url : base + f.url;
      if (AUD.test(f.name)) {
        return `<div class="files__item files__item--media">
          <audio controls preload="metadata" src="${f.url}"></audio>
          <span class="files__meta"><b>${esc(f.name)}</b><small>audio · ${kb ? kb + " KB" : ""}</small></span>
        </div>`;
      }
      if (VID.test(f.name)) {
        return `<div class="files__item files__item--media">
          <video controls preload="metadata" src="${f.url}"></video>
          <span class="files__meta"><b>${esc(f.name)}</b><small>vídeo · ${kb ? kb + " KB" : ""}</small></span>
        </div>`;
      }
      if (IMG.test(f.name)) {
        return `<button type="button" class="files__item" data-img="${f.url}">
          <img class="files__thumb" src="${f.url}" alt="${esc(f.name)}" loading="lazy">
          <span class="files__meta"><b>${esc(f.name)}</b><small>${kb ? kb + " KB" : "imagen"} · ver</small></span>
        </button>`;
      }
      const ext = esc((f.name.split(".").pop() || "?").slice(0, 4).toUpperCase());
      return `<a class="files__item" href="${url}" download="${esc(f.name)}" target="_blank" rel="noopener">
        <span class="files__ext">${ext}</span>
        <span class="files__meta"><b>${esc(f.name)}</b><small>${kb ? kb + " KB" : "archivo"} · descargar</small></span>
      </a>`;
    })
    .join("")}</div>`;
}

/** Visor de imágenes a pantalla completa. */
function openLightbox(url) {
  let box = $("lightbox");
  if (!box) {
    box = document.createElement("div");
    box.id = "lightbox";
    box.className = "lightbox";
    box.innerHTML =
      '<img alt="">' +
      '<div class="lightbox__bar">' +
      '<a class="lightbox__dl" download aria-label="Descargar">⬇ Descargar</a>' +
      '<button class="lightbox__x" aria-label="Cerrar">✕</button>' +
      "</div>";
    document.body.appendChild(box);
    box.addEventListener("click", (e) => {
      if (e.target === box || e.target.classList.contains("lightbox__x")) box.classList.remove("on");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") box.classList.remove("on");
    });
  }
  const img = box.querySelector("img");
  img.src = url;
  // en https las descargas van por http (Chrome bloquea las del certificado propio)
  const dl = box.querySelector(".lightbox__dl");
  const httpUrl = /^https?:/.test(url) ? url.replace(/^https:/, "http:").replace(/:4480\//, ":4479/") : url;
  dl.href = location.protocol === "https:" ? httpUrl : url;
  dl.setAttribute("download", decodeURIComponent(url.split("/").pop() || "imagen"));
  box.classList.add("on");
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-img]");
  if (btn) {
    e.preventDefault();
    openLightbox(btn.dataset.img);
  }
});

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  // Si hay una respuesta en marcha, el botón es de cancelar
  if (busy) {
    cancelar();
    return;
  }
  const t = $("input").value.trim();
  if (!t) return;
  $("input").value = "";
  $("input").style.height = "auto";
  send(t);
});

// Esc también cancela
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && busy) cancelar();
});

$("input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    if (typeof palette !== "undefined" && palette && !palette.hidden) return;
    e.preventDefault();
    $("chatForm").requestSubmit();
  }
});

$("input").addEventListener("input", (e) => {
  const el = e.target;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 180) + "px";
});

$("compactBtn").addEventListener("click", async () => {
  const btn = $("compactBtn");
  btn.disabled = true;
  btn.textContent = "Compactando…";
  try {
    const res = await api("/api/compact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    btn.textContent = `Compactado (${d.before}→${d.after})`;
    setTimeout(() => {
      btn.textContent = "Compactar contexto";
      btn.disabled = false;
    }, 2600);
    refreshStats();
  } catch (e) {
    btn.textContent = "Error al compactar";
    setTimeout(() => {
      btn.textContent = "Compactar contexto";
      btn.disabled = false;
    }, 2600);
  }
});

$("newBtn").addEventListener("click", async () => {
  if (!confirm(t("¿Empezar una conversación nueva? Se perderá el contexto actual."))) return;
  await api("/api/new", { method: "POST" });
  $("msgs").innerHTML = "";
  addMsg("assistant", "Contexto limpio. ¿Por dónde vamos?");
  refreshStats();
});

/* ---------------- rescate de caché vieja ---------------- */
/* Si el service worker sirvió una versión rancia, la app se queda en blanco.
   Tras 8 s sin nada pintado recargamos una sola vez (con query para saltar caché). */
setTimeout(() => {
  const hay = document.querySelector("#msgs .msg");
  const enLogin = !$("login")?.classList.contains("hidden");
  if (hay || enLogin) return;
  if (sessionStorage.getItem("lumi.rescate")) return;
  sessionStorage.setItem("lumi.rescate", "1");
  const url = new URL(location.href);
  url.searchParams.set("r", Date.now());
  location.replace(url.toString());
}, 8000);

/* ---------------- idioma ---------------- */
(() => {
  const caja = $("idiomas");
  if (!caja) return;
  for (const { codigo, etiqueta } of IDIOMAS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = etiqueta;
    b.setAttribute("aria-pressed", String(codigo === idiomaActual()));
    b.addEventListener("click", () => {
      if (codigo !== idiomaActual()) ponerIdioma(codigo);
    });
    caja.appendChild(b);
  }
})();

/* ---------------- estadísticas ---------------- */

let reanudando = null;
let ultimaSync = 0;
async function refreshStats() {
  try {
    const res = await api("/api/stats");
    const d = await res.json();
    const { info, bots, sys } = d;

    $("statusDot").className = "dot on";

    $("s-model").textContent = info.model ?? "—";
    $("s-msgs").textContent = info.messages ?? "—";
    $("s-tools").textContent = (info.tools ?? []).length;

    const st = info.stats;
    if (st) {
      const tk = st.tokens ?? {};
      $("c-in").textContent = fmtNum(tk.input);
      $("c-out").textContent = fmtNum(tk.output);
      $("c-cache").textContent = fmtNum(tk.cacheRead);
      $("c-cost").textContent = st.cost != null ? "$" + Number(st.cost).toFixed(4) : "—";
      const cu = st.contextUsage;
      if (cu && cu.contextWindow) {
        const pct = Number(cu.percent ?? (cu.tokens / cu.contextWindow) * 100);
        const pctR = pct < 10 ? pct.toFixed(1) : Math.round(pct);
        $("ctxBar").style.width = Math.min(pct, 100) + "%";
        $("c-ctx").textContent = `${fmtNum(cu.tokens)} / ${fmtNum(cu.contextWindow)} · ${pctR}%`;
      }
    } else {
      $("c-in").textContent = "—";
    }

    if (sys) {
      $("h-ram").textContent = fmtBytes(sys.ramFree);
      $("h-load").textContent = (sys.load?.[0] ?? 0).toFixed(2);
      $("h-up").textContent = fmtUptime(sys.uptime);
    }

    if (bots) {
      $("b-tag").textContent = bots.tag ?? "—";
      $("b-ping").textContent = bots.ping != null && bots.ping >= 0 ? bots.ping + " ms" : "—";
      $("b-up").textContent = fmtUptime(bots.uptime);
    }
  } catch (e) {
    $("statusDot").className = "dot off";
    const causa = await diagnosticar();
    if (causa === "cert") {
      $("topSub").textContent = t("Certificado no válido");
      aviso(
        "⚠️ <b>Certificado HTTPS no válido.</b> El navegador bloquea las peticiones y la web " +
        "parece desconectada aunque el bot esté vivo. Abre " +
        `<a href="http://${location.hostname}:4477/" style="color:inherit;text-decoration:underline">HTTP (puerto 4477)</a> ` +
        "para uso normal, o acepta el certificado. El micrófono solo funciona con HTTPS válido."
      );
    } else if (causa === "servidor-caido") {
      $("topSub").textContent = t("Servidor caído");
      aviso("⚠️ <b>El servidor no responde.</b> El bot puede estar reiniciándose. Se reconecta solo.");
    } else {
      $("topSub").textContent = t("Reintentando…");
      aviso("");
    }
  }
}

/* ---------------- menú móvil ---------------- */

$("menuBtn").addEventListener("click", () => {
  document.getElementById("side").classList.toggle("open");
});
document.addEventListener("click", (e) => {
  const side = document.getElementById("side");
  if (!side.classList.contains("open")) return;
  if (!side.contains(e.target) && e.target.id !== "menuBtn") side.classList.remove("open");
});

/* ---------------- arranque ---------------- */

async function start() {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  await loadHistory();
  window.__paintSeg?.();
  refreshActivity(true);
  refreshStats();
  // si había un run en curso (cerraste la app mientras respondía), lo retomamos
  reanudarSiOcupado();
  clearInterval(statsTimer);
  statsTimer = setInterval(refreshStats, 7000);
  $("input").focus();
}

(async () => {
  if (!token) return;
  try {
    const res = await api("/api/stats");
    if (res.ok) start();
  } catch {}
})();

/* ============================================================
   Adjuntos: imágenes y notas de voz
   ============================================================ */

let pendingImages = []; // { data, mimeType, name }
let mediaRecorder = null;
let recChunks = [];
let recStart = 0;
let recTimer = null;

/* ---------- imágenes ---------- */

const attachEl = $("attach");

function renderAttach() {
  attachEl.innerHTML = "";
  attachEl.classList.toggle("has", pendingImages.length > 0);
  pendingImages.forEach((im, i) => {
    const d = document.createElement("div");
    d.className = "thumb";
    d.innerHTML = `<img src="data:${im.mimeType};base64,${im.data}" alt="">
      <button type="button" aria-label="Quitar">✕</button>`;
    d.querySelector("button").onclick = () => {
      pendingImages.splice(i, 1);
      renderAttach();
    };
    attachEl.appendChild(d);
  });
}

async function uploadImages(files) {
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    if (f.size > 12 * 1024 * 1024) {
      alert(`${f.name}: demasiado grande (máx 12 MB)`);
      continue;
    }
    const fd = new FormData();
    fd.append("image", f);
    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      pendingImages.push(d);
      renderAttach();
    } catch (e) {
      alert("No pude subir la imagen: " + e.message);
    }
  }
}

$("imgBtn").addEventListener("click", () => $("fileInput").click());

$("fileInput").addEventListener("change", async (e) => {
  await uploadImages([...e.target.files]);
  e.target.value = "";
});

// Pegar imágenes desde el portapapeles
$("input").addEventListener("paste", async (e) => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) {
    e.preventDefault();
    await uploadImages(files);
  }
});

// Arrastrar y soltar
const wrap = document.querySelector(".composer__wrap");
["dragover", "dragenter"].forEach((ev) =>
  wrap.addEventListener(ev, (e) => {
    e.preventDefault();
    wrap.classList.add("drag");
  }),
);
["dragleave", "drop"].forEach((ev) =>
  wrap.addEventListener(ev, (e) => {
    e.preventDefault();
    wrap.classList.remove("drag");
  }),
);
wrap.addEventListener("drop", async (e) => {
  await uploadImages([...(e.dataTransfer?.files ?? [])]);
});

/* ---------- notas de voz ---------- */

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert("Tu navegador no permite grabar audio.");
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    alert("No pude acceder al micrófono. Revisa los permisos del navegador.");
    return;
  }

  const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
  mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recChunks = [];
  mediaRecorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(recTimer);
    $("micBtn").classList.remove("rec");
    $("hint").innerHTML = hintDefault();
    if (!recChunks.length) return;

    const blob = new Blob(recChunks, { type: mediaRecorder.mimeType || "audio/webm" });
    if (blob.size < 1200) return; // demasiado corto
    await sendAudio(blob);
  };

  mediaRecorder.start();
  recStart = Date.now();
  $("micBtn").classList.add("rec");
  const tick = () => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $("hint").innerHTML = `🔴 Grabando… <b>${s}s</b> · pulsa otra vez para enviar`;
  };
  tick();
  recTimer = setInterval(tick, 250);
}

async function sendAudio(blob) {
  $("hint").innerHTML = `<span class="listening">Transcribiendo…</span>`;
  const body = addMsg("assistant", "🎤 _Transcribiendo audio…_");
  body.classList.add("cursor");

  try {
    const fd = new FormData();
    fd.append("audio", blob, "nota.webm");
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "fallo al transcribir");

    const texto = (d.text || "").trim();
    if (!texto) {
      body.innerHTML = render("_No entendí el audio._");
      body.classList.remove("cursor");
      $("hint").innerHTML = HINT_DEFAULT;
      return;
    }

    // Mostrar lo transcrito como mensaje del usuario y continuar
    addMsg("user", `🎤 ${texto}`);
    body.remove();
    $("hint").innerHTML = HINT_DEFAULT;
    await send(texto, true);
  } catch (e) {
    body.innerHTML = render("⚠️ " + e.message);
    body.classList.remove("cursor");
    $("hint").innerHTML = HINT_DEFAULT;
  }
}

function hintDefault() {
  return `<kbd>Enter</kbd> ${t("envía")} · <kbd>Shift</kbd>+<kbd>Enter</kbd> ${t("salto de línea · pulsa el micro para dictar")}`;
}
let HINT_DEFAULT = hintDefault();

$("micBtn").addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  } else {
    startRecording();
  }
});

/* ============================================================
   Panel de actividad: heatmap + consumos
   ============================================================ */

let activity = null;
let ovRange = "all"; // all | 30 | 7
let ovTab = "overview";

const fmtTok = (n) => {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
};

const pad2 = (n) => String(n).padStart(2, "0");
const dayStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Días (YYYY-MM-DD) del rango seleccionado. */
function daysInRange(days) {
  if (ovRange === "all") return days;
  const n = ovRange === "7" ? 7 : 30;
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (n - 1));
  const key = dayStr(from);
  return days.filter((d) => d.date >= key);
}

function streakOf(days) {
  const set = new Set(days.filter((d) => d.messages > 0).map((d) => d.date));
  if (!set.size) return { current: 0, longest: 0 };
  const sorted = [...set].sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1] + "T00:00:00");
    const cur = new Date(sorted[i] + "T00:00:00");
    const diff = Math.round((cur - prev) / 86400000);
    run = diff === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }
  // racha actual: cuenta hacia atrás desde hoy (o ayer)
  let current = 0;
  const cur = new Date();
  cur.setHours(0, 0, 0, 0);
  if (!set.has(dayStr(cur))) cur.setDate(cur.getDate() - 1);
  while (set.has(dayStr(cur))) {
    current++;
    cur.setDate(cur.getDate() - 1);
  }
  return { current, longest };
}

function heatLevel(count, max) {
  if (!count) return 0;
  const r = count / Math.max(max, 1);
  if (r > 0.66) return 4;
  if (r > 0.4) return 3;
  if (r > 0.18) return 2;
  return 1;
}

function renderHeat(days) {
  const el = $("heat");
  if (!el) return;
  const byDate = new Map(days.map((d) => [d.date, d]));

  // Ventana: 17 semanas (o el rango si es menor), alineada a lunes
  const weeks = ovRange === "7" ? 1 : ovRange === "30" ? 5 : 17;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Último día de la ventana = domingo de esta semana
  const end = new Date(today);
  const dow = (end.getDay() + 6) % 7; // 0 = lunes
  end.setDate(end.getDate() + (6 - dow));
  const start = new Date(end);
  start.setDate(end.getDate() - (weeks * 7 - 1));

  const inWindow = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    inWindow.push(new Date(d));
  }
  const max = Math.max(1, ...inWindow.map((d) => byDate.get(dayStr(d))?.messages ?? 0));

  el.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const d of inWindow) {
    const k = dayStr(d);
    const rec = byDate.get(k);
    const count = rec?.messages ?? 0;
    const cell = document.createElement("i");
    const lvl = heatLevel(count, max);
    if (lvl) cell.className = "l" + lvl;
    const label = `${count} mensajes · ${fmtTok(rec?.tokens ?? 0)} tokens · ${k}`;
    cell.title = label;
    frag.appendChild(cell);
  }
  el.appendChild(frag);
  el.scrollLeft = el.scrollWidth;
}

function renderOverview(data) {
  const days = daysInRange(data.days ?? []);
  const sessions = days.reduce((a, d) => a + (d.sessions ?? 0), 0);
  const messages = days.reduce((a, d) => a + d.messages, 0);
  const tokens = days.reduce((a, d) => a + d.tokens, 0);
  const cost = days.reduce((a, d) => a + (d.cost ?? 0), 0);
  const activeDays = days.filter((d) => d.messages > 0).length;
  const { current, longest } = streakOf(days);

  const hours = new Array(24).fill(0);
  for (const d of days) (d.hours ?? []).forEach((v, i) => (hours[i] += v));
  const peak = hours.indexOf(Math.max(...hours));
  const hasPeak = Math.max(...hours) > 0;

  $("ov-sessions").textContent = sessions || "0";
  $("ov-messages").textContent = messages.toLocaleString("es-ES");
  $("ov-tokens").textContent = fmtTok(tokens);
  $("ov-days").textContent = activeDays;
  $("ov-streak").textContent = current + (current === 1 ? " " + t("día") : " " + t("días"));
  $("ov-best").textContent = longest + (longest === 1 ? " " + t("día") : " " + t("días"));
  $("ov-peak").textContent = hasPeak ? `${pad2(peak)}:00 · ${hours[peak]} ${t("msg")}` : "—";
  $("ov-cost").textContent = cost > 0 ? "$" + cost.toFixed(cost < 1 ? 4 : 2) : "—";

  const maxStreak = Math.max(longest, 1);
  $("ov-streak-bar").style.width = Math.round((current / maxStreak) * 100) + "%";
  $("ov-best-bar").style.width = "100%";

  renderHeat(days);

  // Comparativa chorra, como en la referencia
  const lotr = 640000; // ~tokens de El Señor de los Anillos
  const diff = Math.abs(tokens - lotr);
  $("ov-foot").innerHTML =
    tokens >= lotr
      ? `${t("Has usado")} <b>${fmtTok(diff)}</b> ${t("tokens más que El Señor de los Anillos.")}`
      : `${t("Te faltan")} <b>${fmtTok(diff)}</b> ${t("tokens para igualar El Señor de los Anillos.")}`;
}

function renderModels(data) {
  const days = daysInRange(data.days ?? []);
  const from = days.length ? days[0].date : "0000-00-00";
  const agg = new Map();
  for (const m of data.models ?? []) {
    agg.set(m.name, { ...m });
  }
  // Filtrado por rango: solo modelos con actividad en el rango
  const tbody = $("ov-model-rows");
  tbody.innerHTML = "";
  const rows = [...agg.values()].sort((a, b) => b.messages - a.messages);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">Sin datos</td></tr>`;
    return;
  }
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.name}</td><td>${r.messages.toLocaleString("es-ES")}</td><td>${fmtTok(r.tokens)}</td><td>${r.cost > 0 ? "$" + r.cost.toFixed(4) : "—"}</td>`;
    tbody.appendChild(tr);
  }
}

async function refreshActivity(force = false) {
  try {
    const res = await api("/api/activity");
    const d = await res.json();
    activity = d;
    if (ovTab === "overview") renderOverview(d);
    else renderModels(d);
  } catch (e) {
    const f = $("ov-foot");
    if (f) f.textContent = t("No pude cargar la actividad") + ": " + (e?.message ?? "error");
  }
}

/* --- interacción --- */
document.querySelectorAll(".ov__tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".ov__tab").forEach((b) => b.classList.toggle("on", b === btn));
    ovTab = btn.dataset.tab;
    $("ovOverview").classList.toggle("hidden", ovTab !== "overview");
    $("ovModels").classList.toggle("hidden", ovTab !== "models");

    if (activity) ovTab === "overview" ? renderOverview(activity) : renderModels(activity);
  });
});

document.querySelectorAll(".ov__range button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".ov__range button").forEach((b) => b.classList.toggle("on", b === btn));
    ovRange = btn.dataset.range;
    if (activity) ovTab === "overview" ? renderOverview(activity) : renderModels(activity);
  });
});

$("ovToggle").addEventListener("click", () => {
  const ov = $("ov");
  ov.classList.toggle("collapsed");
  localStorage.setItem("valen.ovCollapsed", ov.classList.contains("collapsed") ? "1" : "0");
});

/* Estado del panel: guardado; en móvil se abre plegado por defecto
   (si no, se come media pantalla de conversación). */
const ovGuardado = localStorage.getItem("valen.ovCollapsed");
const empiezaPlegado =
  ovGuardado === null ? window.matchMedia("(max-width: 800px)").matches : ovGuardado === "1";
if (empiezaPlegado) $("ov").classList.add("collapsed");

if (token) refreshActivity();
setInterval(() => { if (token) refreshActivity(); }, 60000);

/* --- el bicho: saluda al pulsarlo --- */
const critter = $("critter");
if (critter) {
  const frases = ["¡Hola!", "¿Qué pasó?", "Aquí estoy", "dale", "👀", "zzz...", "¿otra vez tú?"];
  let i = 0;
  critter.addEventListener("click", () => {
    critter.classList.remove("jump");
    void critter.offsetWidth;
    critter.classList.add("jump");
    critter.title = frases[i++ % frases.length];
  });
}

/* --- el bicho: animaciones y frases --- */
(() => {
  const bicho = $("critter");
  const say = $("critterSay");
  if (!bicho || !say) return;

  const frases = [
    "hola",
    "¿qué hacemos?",
    "aquí sigo",
    "toca código",
    "no me borres",
    "modo morado ON",
    "¿café?",
    "zzz…",
    "compilando…",
    "¡uy!",
    "esto no es un bug, es un feature",
    "déjame pensar",
  ];

  // coreografías: clases + frase + duración
  const rutinas = [
    { cls: "jump", text: "¡wiii!" },
    { cls: "jump", text: "salto cuántico" },
    { cls: "work", text: "abriendo el portátil…", ms: 3400 },
    { cls: "work", text: "programando un bug", ms: 3400 },
    { cls: "work", text: "compilando la esperanza", ms: 3400 },
    { cls: "dance", text: "bailando pixel a pixel", ms: 2600 },
    { cls: "dance", text: "modo fiesta morada", ms: 2600 },
    { cls: "blink", text: "…" },
    { cls: "think", text: "pensando…", ms: 2800 },
    { cls: "wave", text: "adiós" },
    { cls: "cafe", text: "☕ un cafecito", ms: 2200 },
    { cls: "cafe", text: "que me quemo", ms: 2200 },
    { cls: "cool", text: "modo guapo activado", ms: 2400 },
    { cls: "amor", text: "te quiero", ms: 2600 },
    { cls: "amor", text: "💜", ms: 2200 },
    { cls: "dormir", text: "zzz…", ms: 3800 },
    { cls: "dormir", text: "5 minutitos", ms: 3800 },
    { cls: "boost", text: "¡despegue!", ms: 1600 },
  ];

  let i = 0;
  let timers = [];
  const clear = () => {
    timers.forEach(clearTimeout);
    timers = [];
    bicho.classList.remove("jump", "work", "dance", "blink", "think", "wave", "cafe", "cool", "amor", "dormir", "boost", "talk");
  };

  function play(rutina) {
    clear();
    say.textContent = rutina.text;
    void bicho.offsetWidth;
    bicho.classList.add(rutina.cls, "talk");
    timers.push(setTimeout(() => bicho.classList.remove("talk"), rutina.ms || 2200));
    if (rutina.ms) timers.push(setTimeout(() => bicho.classList.remove(rutina.cls), rutina.ms + 400));
  }

  bicho.addEventListener("click", () => {
    play(rutinas[i++ % rutinas.length]);
  });

  // de vez en cuando se anima solo (sin molestar)
  const tranqui = rutinas.filter((r) => ["blink", "think", "dormir", "cafe"].includes(r.cls));
  const idle = () => {
    if (!bicho.classList.contains("talk")) play(tranqui[Math.floor(Math.random() * tranqui.length)]);
    idleTimer = setTimeout(idle, 20000 + Math.random() * 24000);
  };
  let idleTimer = setTimeout(idle, 15000);

  // reacciona mientras escribes
  $("input")?.addEventListener("focus", () => {
    if (!bicho.classList.contains("talk")) play({ cls: "wave", text: "te escucho", ms: 1400 });
  });

  // reacciona cuando la respuesta llega
  document.addEventListener("valen:reply", () => play({ cls: "jump", text: "¡listo!" }));
})();

/* ============================================================
   Paleta de comandos (/ en el composer)
   ============================================================ */

const CMDS = [
  { name: "help", desc: "Lista de comandos disponibles" },
  { name: "status", desc: "Modelo, tokens, coste y contexto" },
  { name: "new", desc: "Empezar conversación nueva (borra el contexto)" },
  { name: "model", desc: "Ver o cambiar el modelo" },
  { name: "thinking", desc: "Nivel de razonamiento: minimal|low|medium|high|max" },
  { name: "compact", desc: "Compactar el contexto" },
  { name: "session", desc: "Sesiones guardadas" },
  { name: "list", desc: "Listar sesiones" },
  { name: "skills", desc: "Skills disponibles" },
  { name: "abort", desc: "Cancelar la respuesta en curso" },
];

let cmdIndex = 0;
let cmdFiltered = [];
const palette = $("cmdPalette");
const cmdList = $("cmdList");

function renderCmdList(query) {
  const q = query.toLowerCase();
  cmdFiltered = CMDS.filter(
    (c) => c.name.startsWith(q) || c.name.includes(q) || c.desc.toLowerCase().includes(q),
  );
  if (!cmdFiltered.length) {
    cmdList.innerHTML = `<div class="cmds__empty">Sin comandos para “${query}”</div>`;
    cmdIndex = 0;
    return;
  }
  cmdIndex = Math.min(cmdIndex, cmdFiltered.length - 1);
  cmdList.innerHTML = cmdFiltered
    .map(
      (c, i) =>
        `<div class="cmds__item${i === cmdIndex ? " on" : ""}" data-name="${c.name}"><b>/${c.name}</b><span>${c.desc}</span></div>`,
    )
    .join("");
  cmdList.querySelectorAll(".cmds__item").forEach((el) => {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      applyCmd(el.dataset.name);
    });
  });
}

function openPalette(query) {
  palette.hidden = false;
  renderCmdList(query);
}

function closePalette() {
  palette.hidden = true;
}

/** Pone el comando en el input listo para añadir argumento. */
function applyCmd(name) {
  $("input").value = "/" + name + " ";
  $("input").focus();
  closePalette();
  $("input").dispatchEvent(new Event("input"));
}

/** Si el texto es un comando, lo ejecuta en el servidor. */
async function runCommand(raw) {
  const m = raw.match(/^\/([a-z]+)\s*([\s\S]*)$/i);
  if (!m) return false;
  const name = m[1].toLowerCase();
  if (!CMDS.some((c) => c.name === name)) return false;

  addMsg("user", raw);
  const out = addMsg("assistant", "…");
  try {
    const res = await api("/api/command", {
      method: "POST",
      body: JSON.stringify({ name, arg: m[2].trim() }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    out.innerHTML = render(d.text || "_(sin salida)_");
    if (d.clear) {
      setTimeout(() => {
        $("msgs").innerHTML = "";
        addMsg("assistant", d.text);
      }, 400);
    }
    refreshStats();
    refreshActivity(true);
  } catch (e) {
    out.innerHTML = render("⚠️ " + e.message);
  }
  setTimeout(scrollDown, 30);
  return true;
}

if (palette) {
  $("input").addEventListener("input", () => {
    const val = $("input").value;
    if (val.startsWith("/") && !val.includes("\n")) {
      openPalette(val.slice(1).split(" ")[0]);
    } else {
      closePalette();
    }
  });

  $("input").addEventListener("keydown", (e) => {
    if (palette.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!cmdFiltered.length) return;
      cmdIndex = (cmdIndex + (e.key === "ArrowDown" ? 1 : -1) + cmdFiltered.length) % cmdFiltered.length;
      renderCmdList($("input").value.slice(1).split(" ")[0]);
    } else if (e.key === "Tab" || e.key === "Enter") {
      if (e.key === "Tab" || !$("input").value.includes(" ")) {
        e.preventDefault();
        if (cmdFiltered[cmdIndex]) applyCmd(cmdFiltered[cmdIndex].name);
      } else {
        closePalette();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    }
  });

  $("input").addEventListener("blur", () => setTimeout(closePalette, 120));
}

/* interceptar envío de comandos */
const origSend = send;
send = async function (text, skipUserEcho = false) {
  if (text && text.startsWith("/") && (await runCommand(text))) return;
  return origSend.call(this, text, skipUserEcho);
};

/* PWA: instalar como app con icono del bicho */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

/* ============================================================
   Selectores con cápsula deslizante (Resumen/Modelos, Todo/30d/7d)
   ============================================================ */
(() => {
  const grupos = ["#navbar .ov__tabs", "#navbar .ov__range"]
    .map((sel) => document.querySelector(sel))
    .filter(Boolean);

  const pintar = (grupo) => {
    const thumb = grupo.querySelector(".seg__thumb");
    const on = grupo.querySelector(".on");
    if (!thumb || !on) return;
    thumb.style.width = `${on.offsetWidth}px`;
    thumb.style.transform = `translateX(${on.offsetLeft - (grupo.scrollLeft || 0)}px)`;
    thumb.style.opacity = "1";
  };

  const pintarTodo = () => grupos.forEach(pintar);
  window.__paintSeg = pintarTodo;

  grupos.forEach((grupo) => {
    // se recoloca cuando cambia la clase .on de cualquier botón
    new MutationObserver(() => pintar(grupo)).observe(grupo, {
      subtree: true,
      attributeFilter: ["class"],
    });
    grupo.addEventListener("click", () => requestAnimationFrame(() => pintar(grupo)));
  });

  // al cargar, al girar el móvil y cuando fuentes/layout cambian
  requestAnimationFrame(pintarTodo);
  window.addEventListener("load", pintarTodo);
  window.addEventListener("resize", () => requestAnimationFrame(pintarTodo));
  if (document.fonts?.ready) document.fonts.ready.then(pintarTodo);
  setTimeout(pintarTodo, 120);
  setTimeout(pintarTodo, 600);
})();

/* Al volver a primer plano (móvil), sincroniza la conversación: si el sistema
   congeló la pestaña, la respuesta puede haberse perdido... o puede seguir en
   marcha: en ese caso vuelve a salir la burbuja "escribiendo" con su contador. */
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  await sincronizar();
  refreshActivity(true);
});

// Volver desde la caché de retroceso (botón atrás o app reabierta)
window.addEventListener("pageshow", async (e) => {
  if (e.persisted) await sincronizar();
});

// La app del móvil a veces recupera el foco sin disparar visibilitychange
window.addEventListener("focus", () => {
  if (!document.hidden) sincronizar();
});



/* navegador en vivo embebido (iframe del servicio :4479) */
(() => {
  const panel = $("browserPanel");
  const frame = $("liveFrame");
  const btn = $("liveBrowser");
  if (!panel || !frame || !btn) return;
  // si la web va por https, el iframe debe ir por https (si no, Chrome lo bloquea)
  const https = location.protocol === "https:";
  // El servicio del navegador exige token: lo pedimos al servidor (firmado, caduca a diario).
  async function urlConToken() {
    try {
      const r = await api(`/api/browser-url?https=${https ? 1 : 0}`);
      const d = await r.json();
      if (d.url) return d.url;
    } catch {}
    return `${https ? "https:" : "http:"}//${location.hostname}:${https ? 4480 : 4479}/`;
  }

  const abrir = async () => {
    document.getElementById("side")?.classList.remove("open"); // en móvil: cerrar el menú
    panel.hidden = false;
    btn.classList.add("on");
    if (!frame.src) frame.src = await urlConToken();
    $("bwinUrl").textContent = `${location.hostname}:${https ? 4480 : 4479}`;
  };
  const cerrar = () => {
    panel.hidden = true;
    btn.classList.remove("on");
  };

  btn.removeAttribute("href");
  btn.removeAttribute("target");
  btn.style.cursor = "pointer";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    panel.hidden ? abrir() : cerrar();
  });
  $("bwinClose")?.addEventListener("click", cerrar);
  $("bwinReload")?.addEventListener("click", async () => {
    frame.src = "about:blank";
    frame.src = await urlConToken();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) cerrar();
  });
})();

/* Branding: lo sirve /api/branding (así el mismo código sirve para MiniValen o Lumi) */
(async () => {
  try {
    const r = await fetch("/api/branding");
    if (!r.ok) return;
    const b = await r.json();
    document.title = b.name;
    document.querySelectorAll("[data-brand]").forEach((el) => {
      const k = el.dataset.brand;
      if (b[k]) el.textContent = b[k];
    });
    document
      .querySelectorAll('meta[name="apple-mobile-web-app-title"], meta[name="application-name"]')
      .forEach((m) => (m.content = b.short || b.name));
  } catch {}
})();

/* ============================================================
   Ajustes (pestaña en la web)
   ============================================================ */
const SET_MAP = [
  ["brand.name", "brand", "name"],
  ["brand.tagline", "brand", "tagline"],
  ["discord.token", "discord", "token"],
  ["discord.ownerIds", "discord", "ownerIds"],
  ["discord.guildAllowlist", "discord", "guildAllowlist"],
  ["discord.maxQueue", "discord", "maxQueue"],
  ["model.thinkingLevel", "model", "thinkingLevel"],
  ["model.agentCwd", "model", "agentCwd"],
  ["web.webPort", "web", "webPort"],
  ["web.webPortHttps", "web", "webPortHttps"],
  ["web.https", "web", "https"],
  ["voice.enabled", "voice", "enabled"],
  ["voice.device", "voice", "device"],
  ["voice.voice", "voice", "voice"],
  ["voice.mediaBase", "voice", "mediaBase"],
  ["push.ntfyTopic", "push", "ntfyTopic"],
  ["browser.port", "browser", "port"],
];

function ponerValor(form, nombre, valor) {
  const el = form.elements[nombre];
  if (!el) return;
  if (el.type === "checkbox") el.checked = !!valor;
  else if (Array.isArray(valor)) el.value = valor.join(", ");
  else if (valor !== undefined && valor !== null) el.value = valor;
}

async function cargarAjustes() {
  const form = $("settingsForm");
  if (!form || form.dataset.cargado === "1") return;
  try {
    const res = await api("/api/settings");
    const d = await res.json();
    SET_MAP.forEach(([campo, grupo, clave]) => ponerValor(form, campo, d[grupo]?.[clave]));
    form.dataset.cargado = "1";
    $("setHint").textContent = "";
  } catch (e) {
    $("setHint").textContent = "⚠ " + e.message;
  }
}

$("settingsForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const num = (v) => (v === "" ? undefined : Number(v));
  const lista = (v) =>
    v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const body = {
    brand: { name: form.elements["brand.name"].value, tagline: form.elements["brand.tagline"].value },
    discord: {
      token: form.elements["discord.token"].value,
      ownerIds: lista(form.elements["discord.ownerIds"].value),
      guildAllowlist: lista(form.elements["discord.guildAllowlist"].value),
      maxQueue: num(form.elements["discord.maxQueue"].value),
    },
    model: {
      thinkingLevel: form.elements["model.thinkingLevel"].value,
      agentCwd: form.elements["model.agentCwd"].value,
    },
    web: {
      webPort: num(form.elements["web.webPort"].value),
      webPortHttps: num(form.elements["web.webPortHttps"].value),
      https: form.elements["web.https"].checked,
    },
    voice: {
      enabled: form.elements["voice.enabled"].checked,
      device: form.elements["voice.device"].value,
      voice: form.elements["voice.voice"].value,
      mediaBase: form.elements["voice.mediaBase"].value,
    },
    push: { ntfyTopic: form.elements["push.ntfyTopic"].value },
    browser: { port: num(form.elements["browser.port"].value) },
  };

  const pista = $("setHint");
  const decir = (texto, malo = false) => {
    pista.textContent = texto;
    pista.classList.toggle("set__hint--error", malo);
    // el aviso vive al final de la hoja: lo traemos a la vista
    pista.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const botonGuardar = $("settingsForm")?.querySelector('button[type="submit"]');
  const textoBoton = botonGuardar?.textContent;
  if (botonGuardar) botonGuardar.textContent = t("Guardando…");
  decir(t("guardando…"));
  try {
    const res = await api("/api/settings", { method: "POST", body: JSON.stringify(body) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "error");
    decir("✓ " + t("guardado. Reinicia el bot para aplicarlo."));
    setTimeout(() => {
      // fuera de la hoja salvo que haya un error, para que se note que se ha guardado
      if (!pista.classList.contains("set__hint--error")) {
        document.getElementById("settingsSheet").hidden = true;
      }
    }, 1400);
  } catch (err) {
    decir("⚠ " + err.message, true);
  } finally {
    if (botonGuardar) botonGuardar.textContent = textoBoton;
  }
});

document.querySelectorAll("[data-test]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const what = btn.dataset.test;
    btn.disabled = true;
    const antes = btn.textContent;
    btn.textContent = "probando…";
    try {
      const res = await api("/api/settings/test", {
        method: "POST",
        body: JSON.stringify({ what }),
      });
      const d = await res.json();
      $("setHint").textContent = (d.ok ? "✓ " : "⚠ ") + (d.info || d.error || (d.ok ? "ok" : "falló"));
    } catch (err) {
      $("setHint").textContent = "⚠ " + err.message;
    }
    btn.textContent = antes;
    btn.disabled = false;
  });
});

/* Ajustes: hoja que se abre desde el menú hamburguesa */
(() => {
  const hoja = $("settingsSheet");
  const btn = $("settingsBtn");
  if (!hoja || !btn) return;

  const abrir = () => {
    document.getElementById("side")?.classList.remove("open");
    document.getElementById("settingsForm").dataset.cargado = "";
    hoja.hidden = false;
    cargarAjustes();
  };
  const cerrar = () => {
    hoja.hidden = true;
  };

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    hoja.hidden ? abrir() : cerrar();
  });
  $("settingsClose")?.addEventListener("click", cerrar);
  hoja.addEventListener("click", (e) => {
    if (e.target === hoja) cerrar();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !hoja.hidden) cerrar();
  });
})();

/* ============================================================
   Si cierras la app mientras respondo, al volver seguimos esperando
   ============================================================ */
async function estadoServidor() {
  try {
    const res = await api("/api/state");
    return await res.json();
  } catch {
    return { busy: false };
  }
}

async function reanudarSiOcupado() {
  clearInterval(reanudando);
  const st = await estadoServidor();
  if (!st.busy) {
    $("topSub").textContent = t("Conectado");
    return;
  }
  // No estamos viendo el stream (app cerrada, pestaña en segundo plano, página
  // recargada): la burbuja de "escribiendo" tiene que volver a aparecer o
  // parece que se ha quedado callado. Y el botón pasa a "cancelar".
  if (!busy) burbujaPendiente();
  modoCancelar();
  const desde = st.since ? Date.now() - st.since : 0;
  const startTime = Date.now();
  const marca = () => {
    const s = Math.floor(desde / 1000 + (Date.now() - startTime) / 1000);
    $("topSub").textContent = `${t("Escribiendo")}… ${s}s`;
  };
  marca();
  reanudando = setInterval(async () => {
    marca();
    const ahora = await estadoServidor();
    if (!ahora.busy) {
      clearInterval(reanudando);
      quitarBurbujaPendiente();
      await loadHistory();
      scrollDown();
      refreshStats();
      modoEscribir();
      $("topSub").textContent = t("Conectado");
    }
  }, 2500);
}

/** Burbuja de "escribiendo" para una respuesta que no estamos streameando. */
function burbujaPendiente() {
  const ya = document.querySelector("#msgs .msg.assistant.streaming");
  if (ya) return ya.querySelector(".msg__body");
  const body = addMsg("assistant", "");
  body.parentElement?.classList.add("streaming");
  body.classList.add("cursor");
  // Texto explícito: si sólo queda el caret parpadeando no se entiende que
  // sigo trabajando mientras la app estaba cerrada.
  body.innerHTML = render("_escribiendo…_") ;
  return body;
}

function quitarBurbujaPendiente() {
  document.querySelectorAll("#msgs .msg.assistant.streaming").forEach((el) => el.remove());
}

/**
 * Al volver a la app: ¿el servidor sigue trabajando? Si sí, burbuja + contador;
 * si no, recargamos la conversación (por si la respuesta llegó mientras no
 * mirábamos).
 */
async function sincronizar() {
  // "focus" puede dispararse varias veces seguidas: no recargamos en bucle.
  const ahora = Date.now();
  if (ahora - ultimaSync < 1500) return;
  ultimaSync = ahora;
  const st = await estadoServidor();
  if (st.busy) {
    if (!busy) burbujaPendiente();
    modoCancelar();
    reanudarSiOcupado();
    return;
  }
  if (busy) return; // stream propio vivo: no lo pisamos
  modoEscribir();
  quitarBurbujaPendiente();
  await loadHistory();
  scrollDown();
  refreshStats();
  $("topSub").textContent = t("Conectado");
}
