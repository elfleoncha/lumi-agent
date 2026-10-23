/**
 * Traducciones del servidor (los pocos mensajes que ve el usuario).
 * El idioma se deduce de la cabecera Accept-Language que manda el navegador.
 */
const TEXTOS = {
  es: {
    "no autorizado": "no autorizado",
    "contraseña incorrecta": "contraseña incorrecta",
    "demasiados intentos": "demasiados intentos, prueba en {n} min",
    "falta webPassword en config.json": "falta webPassword en config.json",
    "sin imagen": "sin imagen",
    "solo se aceptan imágenes": "solo se aceptan imágenes",
    "prueba desconocida": "prueba desconocida",
    "sin audio": "sin audio",
  },
  en: {
    "no autorizado": "unauthorized",
    "contraseña incorrecta": "wrong password",
    "demasiados intentos": "too many attempts, try again in {n} min",
    "falta webPassword en config.json": "webPassword missing in config.json",
    "sin imagen": "no image",
    "solo se aceptan imágenes": "images only",
    "prueba desconocida": "unknown test",
    "sin audio": "no audio",
  },
};

export function idiomaDe(req) {
  const cabecera = String(req?.headers?.["accept-language"] ?? "").toLowerCase();
  if (cabecera.startsWith("en") || cabecera.includes(",en")) return "en";
  return "es";
}

export function tr(req, clave, vars = {}) {
  const idioma = idiomaDe(req);
  const texto = TEXTOS[idioma]?.[clave] ?? TEXTOS.es[clave] ?? clave;
  return texto.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}
