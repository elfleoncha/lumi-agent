#!/bin/bash
# Prueba de humo: arranca Lumi en modo sólo-web en un puerto libre y comprueba
# lo mínimo (salud, login, que la API no responda sin token). Sirve para CI y
# para verificar una instalación sin tocar la de verdad.
#
#   ./scripts/smoke-test.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PUERTO="${PUERTO:-4499}"
TMP="$(mktemp -d)"
LOG="$TMP/lumi.log"
PID=""

limpiar() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null
  wait "$PID" 2>/dev/null
  rm -rf "$TMP"
}
trap limpiar EXIT

cat > "$TMP/config.json" <<EOF
{
  "ownerIds": ["1"],
  "guildAllowlist": [],
  "sessionDir": "$TMP/sessions",
  "agentCwd": "$TMP",
  "webPort": $PUERTO,
  "webPortHttps": 0,
  "browserPort": 0,
  "thinkingLevel": "minimal",
  "appName": "Lumi",
  "sessionMaxMb": 0
}
EOF
echo '{"token":"","webPassword":"prueba-de-humo"}' > "$TMP/secret.json"

fallo() { echo "✗ $1"; echo "--- log ---"; tail -20 "$LOG"; exit 1; }

echo "· arrancando en el puerto $PUERTO"
LUMI_CONFIG="$TMP/config.json" LUMI_SECRET="$TMP/secret.json" \
LUMI_NO_DISCORD=1 node src/index.js > "$LOG" 2>&1 &
PID=$!

for i in $(seq 1 40); do
  sleep 0.5
  if curl -fsS "http://127.0.0.1:$PUERTO/api/health" >/dev/null 2>&1; then break; fi
  kill -0 "$PID" 2>/dev/null || fallo "el proceso murió al arrancar"
done

curl -fsS "http://127.0.0.1:$PUERTO/api/health" >/dev/null || fallo "no responde /api/health"
echo "  ✓ /api/health"

CODIGO=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PUERTO/api/history")
[ "$CODIGO" = "401" ] || fallo "sin token debería ser 401, fue $CODIGO"
echo "  ✓ /api/history sin token → 401"

TOKEN=$(curl -s -X POST "http://127.0.0.1:$PUERTO/api/login" \
  -H 'Content-Type: application/json' -d '{"password":"prueba-de-humo"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).token)}catch(e){console.log('')}})")
[ -n "$TOKEN" ] || fallo "el login no devolvió token"
echo "  ✓ login"

CODIGO=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PUERTO/api/history" \
  -H "Authorization: Bearer $TOKEN")
[ "$CODIGO" = "200" ] || fallo "con token debería ser 200, fue $CODIGO"
echo "  ✓ /api/history con token → 200"

for i in 1 2 3 4 5 6; do
  CODIGO=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:$PUERTO/api/login" \
    -H 'Content-Type: application/json' -d '{"password":"malo"}')
done
[ "$CODIGO" = "429" ] || fallo "tras 6 intentos fallidos debería bloquear (429), fue $CODIGO"
echo "  ✓ fuerza bruta bloqueada"

echo "✓ prueba de humo correcta"
exit 0
