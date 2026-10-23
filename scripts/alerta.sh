#!/bin/bash
# Aviso en casa: efecto de sonido + voz, y opcionalmente push al móvil.
# uso: scripts/alerta.sh NIVEL "mensaje" ["Dispositivo"] [--push]
#   NIVEL: ok | success | alert | error
set -u
NIVEL="${1:-ok}"; MENSAJE="${2:-Aviso de MiniValen}"; DISPOSITIVO="${3:-Estudio}"; PUSH="${4:-}"
cd "$(dirname "$0")/.."
.venv/bin/python scripts/decir.py --device "$DISPOSITIVO" --sfx "$NIVEL" --volume 0.55 "$MENSAJE"
if [ "$PUSH" = "--push" ]; then
  node -e "import('./src/notify.js').then(m=>m.notify('MiniValen', process.argv[1], {tags:['bell']}))" "$MENSAJE" >/dev/null 2>&1
fi
