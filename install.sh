#!/bin/bash
# Instalador de Lumi: deja el proyecto listo para arrancar.
#
#   ./install.sh              instala aquí mismo
#   ./install.sh /opt/lumi    copia a otra ruta
#
# Hace: comprueba Node, instala dependencias, crea config/secret si faltan,
# prepara el venv de Python (opcional) e imprime el servicio systemd.
set -euo pipefail

ORIGEN="$(cd "$(dirname "$0")" && pwd)"
DESTINO="${1:-$ORIGEN}"

verde() { printf '\033[38;5;114m%s\033[0m\n' "$1"; }
aviso() { printf '\033[38;5;214m%s\033[0m\n' "$1"; }

echo "· comprobando Node"
if ! command -v node >/dev/null 2>&1; then
  echo "Hace falta Node 20 o superior: https://nodejs.org" >&2
  exit 1
fi
MAYOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$MAYOR" -ge 20 ] || { echo "Node $(node -v) es demasiado antiguo (mínimo 20)" >&2; exit 1; }
verde "  node $(node -v) ok"

if [ "$DESTINO" != "$ORIGEN" ]; then
  echo "· copiando a $DESTINO"
  mkdir -p "$DESTINO"
  rsync -a --exclude node_modules --exclude .venv --exclude sessions \
        --exclude certs --exclude certs-tls --exclude .git \
        --exclude public/files --exclude media --exclude uploads \
        "$ORIGEN"/ "$DESTINO"/
fi
cd "$DESTINO"

echo "· dependencias de Node"
npm install --omit=dev --no-audit --no-fund

[ -f config.json ] || { cp config.example.json config.json; aviso "  creado config.json — edita ownerIds y appName"; }
[ -f secret.json ] || {
  cp secret.example.json secret.json
  chmod 600 secret.json
  aviso "  creado secret.json — pon tu token de Discord y tu webPassword"
}
chmod 600 config.json secret.json 2>/dev/null || true

if command -v python3 >/dev/null 2>&1; then
  echo "· venv de Python (voz y navegador; se puede omitir con NO_PY=1)"
  if [ "${NO_PY:-0}" != "1" ]; then
    python3 -m venv .venv
    ./.venv/bin/pip install --quiet --upgrade pip
    ./.venv/bin/pip install --quiet -r requirements.txt || aviso "  algunas dependencias de Python fallaron (voz/navegador no estarán)"
    command -v ffmpeg >/dev/null 2>&1 || aviso "  falta ffmpeg (necesario para transcribir y convertir audio)"
  fi
fi

mkdir -p sessions uploads public/files

verde "✓ Lumi instalado en $DESTINO"
cat <<EOF

Siguiente:
  1. edita config.json   (ownerIds = tu ID de Discord, appName...)
  2. edita secret.json   (token del bot y webPassword del panel)
  3. arranca:   node src/index.js
     o solo web: LUMI_NO_DISCORD=1 node src/index.js

Servicio systemd:
  sudo sed "s|%i|$USER|g; s|/home/$USER/lumi|$DESTINO|" deploy/lumi.service > /etc/systemd/system/lumi.service
  sudo systemctl daemon-reload && sudo systemctl enable --now lumi

Panel: http://localhost:4477  (con el webPassword de secret.json)
EOF
