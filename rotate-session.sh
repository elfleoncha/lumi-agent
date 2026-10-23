#!/bin/bash
# Mantiene ligera la sesión de MiniValen.
#
# Por qué existe: pi escribe cada turno al JSONL y compactar AÑADE entradas,
# nunca borra. Con miles de mensajes el fichero llegó a 36 MB y cada respuesta
# pasó de 1 s a más de 10 s (Leon lo percibía como "no contesta").
#
# Qué hace:
#   1. Si el .jsonl del DM supera UMBRAL_MB, archiva la conversación en texto
#      y deja espacio para empezar de cero (el bot la recrea solo).
#   2. Rota los backups antiguos de sessions/_archivo (deja los 2 últimos).
#
# NO toca el .jsonl mientras el bot esté escribiendo: comprueba que el tamaño
# es estable durante dos lecturas separadas 5 s.
set -u

DIR="$(cd "$(dirname "$0")" && pwd)/sessions"
ARCH="$DIR/_archivo"
UMBRAL_MB=${UMBRAL_MB:-18}
PM2="${PM2_BIN:-pm2}"
OUT="${LUMI_LOG_DIR:-$(dirname "$(dirname "$0")")/backups}/session-rotate.log"

mkdir -p "$ARCH"
log() { echo "$(date '+%F %T') $*" >> "$OUT"; }

# El fichero del DM (el dueño está en config.json). OJO: pi nombra los
# ficheros nuevos con timestamp, así que no siempre es <key>.jsonl.
OWNER=$(node -e "try{console.log(require(process.env.LUMI_CONFIG || 'config.json').ownerIds[0])}catch(e){}" 2>/dev/null)
F=$(node -e '
const fs = require("fs"), dir = process.argv[1], key = "dm-" + process.argv[2];
let links = {};
try { links = JSON.parse(fs.readFileSync(dir + "/links.json", "utf8")); } catch {}
let f = links[key];
if (!f || !fs.existsSync(f)) {
  const c = fs.readdirSync(dir).filter((x) => x.endsWith(".jsonl"))
    .map((x) => ({ x, t: fs.statSync(dir + "/" + x).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  f = c.length ? dir + "/" + c[0].x : "";
}
console.log(f);
' "$DIR" "$OWNER" 2>/dev/null)
[ -n "$F" ] && [ -f "$F" ] || exit 0

S1=$(stat -c %s "$F")
[ "$S1" -lt $((UMBRAL_MB * 1024 * 1024)) ] && exit 0

sleep 5
S2=$(stat -c %s "$F")
if [ "$S1" != "$S2" ]; then
  log "saltado: la sesión sigue creciendo ($S1 -> $S2)"
  exit 0
fi

# 1) Volcado legible de la conversación (nunca perder el contenido)
STAMP=$(date '+%F-%H%M')
TXT="${LUMI_LOG_DIR:-$(dirname "$(dirname "$0")")/backups}/conversacion-${STAMP}.txt"
python3 - "$F" "$TXT" <<'PY' 2>/dev/null
import json, sys
src, dst = sys.argv[1], sys.argv[2]
n = 0
with open(dst, "w") as out:
    for line in open(src, errors="ignore"):
        try:
            e = json.loads(line)
        except Exception:
            continue
        if e.get("type") != "message":
            continue
        m = e.get("message") or {}
        if m.get("role") not in ("user", "assistant"):
            continue
        c = m.get("content")
        if isinstance(c, list):
            c = "".join(x.get("text", "") for x in c if isinstance(x, dict) and x.get("type") == "text")
        if not (c or "").strip():
            continue
        out.write(f"[{m['role']}] {c}\n\n")
        n += 1
print(n)
PY

# 2) Archivar el jsonl y dejar que el bot cree uno nuevo
mv "$F" "$ARCH/dm-${STAMP}.jsonl"
# el enlace ya no vale: el bot creará una sesión nueva y la enlazará él
node -e '
const fs = require("fs"), p = process.argv[1] + "/links.json";
try {
  const l = JSON.parse(fs.readFileSync(p, "utf8"));
  delete l["dm-" + process.argv[2]];
  fs.writeFileSync(p, JSON.stringify(l, null, 2));
} catch {}
' "$DIR" "$OWNER" 2>/dev/null
log "rotada sesión $F ($((S1 / 1024 / 1024)) MB) -> $TXT ($(grep -c '^\[' "$TXT" 2>/dev/null) mensajes)"

# 3) Reiniciar el bot para que suelte el fichero viejo
$PM2 restart valen-bot >/dev/null 2>&1

# 4) Rotación: dejar solo los 2 archivos más recientes
ls -1t "$ARCH"/dm-*.jsonl 2>/dev/null | tail -n +3 | while read -r old; do
  rm -f "$old"
done
ls -1t "${LUMI_LOG_DIR:-$(dirname "$(dirname "$0")")/backups}"/conversacion-*.txt 2>/dev/null | tail -n +6 | while read -r old; do
  rm -f "$old"
done
