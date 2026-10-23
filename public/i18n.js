/**
 * Traducciones de la interfaz (ES/EN).
 *
 * La clave es el texto original en español: así no hay que inventar claves ni
 * tocar cada etiqueta, y si una cadena no está en el diccionario se queda tal
 * cual. Para añadir un idioma, copia el bloque `en` y traduce los valores.
 *
 * Uso:
 *   t("Ajustes")                    -> "Settings"
 *   aplicar(document)               -> traduce los nodos marcados/estáticos
 *   ponerIdioma("en")               -> guarda y recarga
 */
const DICT = {
  en: {
    // ---- navegación y cabecera
    "Acceso privado": "Private access",
    "Activar voz": "Enable voice",
    "Ajustes": "Settings",
    "Asistente": "Assistant",
    "Cerrar": "Close",
    "Comandos ·": "Commands ·",
    "Compactar contexto": "Compact context",
    "completar ·": "complete ·",
    "Conectado": "Connected",
    "conectando…": "connecting…",
    "Conversación": "Conversation",
    "Enviar": "Send",
    "envía ·": "sends ·",
    "Esc": "Esc",
    "Enter": "Enter",
    "Shift": "Shift",
    "Tab": "Tab",
    "mover ·": "move ·",
    "Menú": "Menu",
    "Mostrar/ocultar": "Show/hide",
    "Nueva conversación": "New conversation",
    "Recargar": "Reload",
    "Salir": "Log out",
    "Cancelar": "Cancel",
    "Cancelado": "Cancelled",
    "Cancelando…": "Cancelling…",
    "Resumen": "Overview",
    "Modelos": "Models",
    "Todo": "All",
    "Volver": "Back",

    // ---- panel lateral
    "Sesión": "Session",
    "Modelo": "Model",
    "Mensajes": "Messages",
    "Herramientas": "Tools",
    "Consumo": "Usage",
    "Entrada": "Input",
    "Salida": "Output",
    "Cache": "Cache",
    "Contexto": "Context",
    "Coste": "Cost",
    "Servidor": "Server",
    "RAM libre": "Free RAM",
    "Carga": "Load",
    "Uptime": "Uptime",
    "Discord": "Discord",
    "Cuenta": "Account",
    "Latencia": "Latency",
    "Navegador": "Browser",
    "Ver navegador en vivo": "Watch live browser",
    "navegador en vivo": "live browser",

    // ---- resumen
    "Sesiones": "Sessions",
    "Tokens": "Tokens",
    "Tokens totales": "Total tokens",
    "Días activos": "Active days",
    "Racha actual": "Current streak",
    "Racha máxima": "Longest streak",
    "Hora punta": "Peak hour",
    "Cargando actividad…": "Loading activity…",
    "Actividad por día": "Activity per day",

    // ---- compositor
    "Escribe un mensaje…": "Type a message…",
    "Adjuntar imagen": "Attach image",
    "Imagen": "Image",
    "Grabar audio": "Record audio",
    "Contraseña": "Password",
    "Entrar": "Sign in",
    "Escribiendo…": "Typing…",

    // ---- ajustes
    "Guardar ajustes": "Save settings",
    "Marca": "Branding",
    "Nombre": "Name",
    "Tagline": "Tagline",
    "Modelo y razonamiento": "Model and reasoning",
    "Directorio de trabajo": "Working directory",
    "Token del bot": "Bot token",
    "IDs dueños (coma)": "Owner IDs (comma)",
    "Guilds permitidos (coma, vacío = todos)": "Allowed guilds (comma, empty = all)",
    "Cola máx.": "Max queue",
    "Web": "Web",
    "Puerto HTTP": "HTTP port",
    "Puerto HTTPS": "HTTPS port",
    "Puerto": "Port",
    "HTTPS": "HTTPS",
    "Voz (altavoces Cast)": "Voice (Cast speakers)",
    "Dispositivo": "Device",
    "URL de audio (IP que ve el altavoz)": "Audio URL (IP the speaker sees)",
    "Notificaciones push": "Push notifications",
    "Tema de ntfy": "ntfy topic",
    "Probar voz": "Test voice",
    "Probar push": "Test push",
    "Probar Discord": "Test Discord",
    "Álvaro (ES, hombre)": "Álvaro (ES, male)",
    "Elvira (ES, woman)": "Elvira (ES, female)",
    "Jorge (MX, hombre)": "Jorge (MX, male)",
    "Tomás (AR, hombre)": "Tomás (AR, male)",
    "Elvira (ES, mujer)": "Elvira (ES, female)",
    "Jorge (MX, hombre) ": "Jorge (MX, male)",
    "sin cambios": "unchanged",
    "(sin cambios)": "(unchanged)",

    // ---- textos generados
    "día": "day",
    "días": "days",
    "msg": "msg",
    "envía": "sends",
    "salto de línea · pulsa el micro para dictar": "new line · press the mic to dictate",
    "Has usado": "You have used",
    "Te faltan": "You need",
    "tokens más que El Señor de los Anillos.": "more tokens than The Lord of the Rings.",
    "tokens para igualar El Señor de los Anillos.": "tokens to match The Lord of the Rings.",
    "No pude cargar la actividad": "Could not load activity",
    "No pude cancelar": "Could not cancel",
    "Certificado no válido": "Invalid certificate",
    "Servidor caído": "Server down",
    "Reintentando…": "Retrying…",

    // ---- avisos y errores del panel
    "Hola. Aquí estoy, desde el navegador.": "Hi. I'm here, from the browser.",
    "Se cortó la conexión": "Connection dropped",
    "Reintentar": "Retry",
    "Reconectando…": "Reconnecting…",
    "No pude cargar la actividad": "Could not load activity",
    "debes iniciar sesión": "you need to sign in",
    "sesión caducada": "session expired",
    "Ese comando no existe": "no such command",
    "¿Empezar una conversación nueva? Se perderá el contexto actual.":
      "Start a new conversation? The current context will be lost.",
    "Compilando contexto…": "Compacting context…",
    "Contexto compactado": "Context compacted",
    "Error al compactar": "Failed to compact",
    "Pedir al micrófono permiso": "Asking for microphone permission",
    "No pude acceder al micrófono": "Could not access the microphone",
    "Grabando…": "Recording…",
    "En cola: esperando a que termine la respuesta anterior…":
      "Queued: waiting for the previous answer to finish…",
    "El servidor no responde.": "The server is not responding.",
    "Certificado HTTPS no válido.": "Invalid HTTPS certificate.",
  },
};

const CLAVE = "lumi.idioma";

function detectado() {
  let guardado = null;
  try {
    guardado = localStorage.getItem(CLAVE);
  } catch {}
  if (guardado) return guardado;
  const nav = (navigator.language || "es").toLowerCase();
  return nav.startsWith("es") ? "es" : "en";
}

let idioma = detectado();

export function idiomaActual() {
  return idioma;
}

export function t(texto) {
  const d = DICT[idioma];
  return (d && d[texto]) || texto;
}

export function ponerIdioma(nuevo) {
  try {
    localStorage.setItem(CLAVE, nuevo);
  } catch {}
  document.documentElement.lang = nuevo;
  location.reload();
}

/** Traduce un texto plano (para avisos que se construyen a mano). */
export function tr(texto) {
  return t(texto);
}

// Nodos cuyo TEXTO no se traduce: la conversación y el código.
const SIN_TEXTO = new Set(["MSGS", "CODE", "PRE", "SCRIPT", "STYLE", "TEXTAREA"]);
// Nodos donde tampoco tocamos atributos (no los necesitan).
const SIN_ATRIBUTOS = new Set(["MSGS", "CODE", "PRE", "SCRIPT", "STYLE"]);

function dentroDe(nodo, conjunto) {
  for (let n = nodo; n && n.nodeType === 1; n = n.parentElement) {
    if (conjunto.has(n.id) || conjunto.has(n.tagName)) return true;
  }
  return false;
}

const excluido = (nodo) => dentroDe(nodo, SIN_TEXTO);

/** Traduce el texto de un nodo si tenemos su traducción. Idempotente. */
function traducirNodoTexto(nodo) {
  const original = nodo.__original ?? nodo.nodeValue;
  const limpio = original.trim();
  if (!limpio) return;
  const nuevo = t(limpio);
  if (nuevo === limpio) return;
  nodo.__original = original;
  const sangria = original.match(/^\s*/)[0];
  const cola = original.match(/\s*$/)[0];
  nodo.nodeValue = sangria + nuevo + cola;
}

// originales de atributos (dataset no admite guiones en el nombre)
const originales = new WeakMap();

function traducirAtributo(el, attr) {
  const mapa = originales.get(el) ?? {};
  if (mapa[attr] === undefined) mapa[attr] = el.getAttribute(attr);
  originales.set(el, mapa);
  const original = mapa[attr];
  if (!original) return;
  const nuevo = t(original);
  if (nuevo !== original) el.setAttribute(attr, nuevo);
}

/** Recorre el árbol y traduce textos, placeholders, títulos y aria-labels. */
export function aplicar(raiz = document.body) {
  if (!raiz) return;
  document.documentElement.lang = idioma;

  const paseo = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (excluido(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodos = [];
  while (paseo.nextNode()) nodos.push(paseo.currentNode);
  for (const n of nodos) traducirNodoTexto(n);

  for (const el of raiz.querySelectorAll("[placeholder],[title],[aria-label]")) {
    if (dentroDe(el, SIN_ATRIBUTOS)) continue;
    if (el.hasAttribute("placeholder")) traducirAtributo(el, "placeholder");
    if (el.hasAttribute("title")) traducirAtributo(el, "title");
    if (el.hasAttribute("aria-label")) traducirAtributo(el, "aria-label");
  }
}

/** Traduce lo que se añada después (avisos, tarjetas, estados). */
export function vigilar(raiz = document.body) {
  if (!raiz || typeof MutationObserver === "undefined") return;
  const ob = new MutationObserver((cambios) => {
    for (const c of cambios) {
      if (c.type === "characterData") {
        if (!excluido(c.target)) {
          const limpio = (c.target.__original ?? c.target.nodeValue).trim();
          if (limpio && t(limpio) !== limpio) traducirNodoTexto(c.target);
        }
      } else {
        for (const n of c.addedNodes) {
          if (n.nodeType === 1) aplicar(n);
          else if (n.nodeType === 3 && !excluido(n)) traducirNodoTexto(n);
        }
      }
    }
  });
  ob.observe(raiz, { childList: true, subtree: true, characterData: true });
  return ob;
}

export const IDIOMAS = [
  { codigo: "es", etiqueta: "ES" },
  { codigo: "en", etiqueta: "EN" },
];
