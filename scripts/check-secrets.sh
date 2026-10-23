#!/bin/bash
# Revisa que no se cuele nada personal antes de publicar Lumi.
#   ./scripts/check-secrets.sh
# Sale con código 1 si encuentra algo. Pensado para ejecutarse antes de cada push.
set -u
cd "$(dirname "$0")/.." || exit 1

FALLOS=0
aviso() { echo "  ✗ $1"; FALLOS=$((FALLOS + 1)); }

SENSIBLES=(secret.json config.json links.json .env)
DIRS_SENSIBLES=(certs certs-tls sessions media uploads .browser-profile backups .venv)

# Si hay repo git, solo cuenta lo que se subiría de verdad (git ls-files).
EN_GIT=0
git rev-parse --git-dir >/dev/null 2>&1 && EN_GIT=1

# ¿Está ignorado este path? (sin repo, lo damos por bueno si existe .gitignore)
ignorado() {
  local p="$1"
  if [ "$EN_GIT" = "1" ]; then
    git check-ignore -q "$p" && return 0
    return 1
  fi
  grep -qE "^${p%/}/?$|^${p%/}/\*|^${p##*/}$|\*\.${p##*.}$" .gitignore 2>/dev/null
}

echo "· datos sensibles que NO deben publicarse"
for f in "${SENSIBLES[@]}"; do
  [ -e "$f" ] || continue
  if ignorado "$f"; then
    echo "  · $f (presente, ignorado por git ✓)"
  else
    aviso "$f NO está ignorado → se subiría"
  fi
done
for d in "${DIRS_SENSIBLES[@]}"; do
  [ -d "$d" ] || continue
  if ignorado "$d"; then
    echo "  · $d/ (presente, ignorado por git ✓)"
  else
    aviso "$d/ NO está ignorado → se subiría"
  fi
done

# Lista de ficheros a escanear: los del repo, o el árbol menos lo ignorado.
if [ "$EN_GIT" = "1" ]; then
  # el propio escáner contiene los patrones: no se escanea a sí mismo
  mapfile -t FICHEROS < <(git ls-files | grep -v "^scripts/check-secrets.sh$")
else
  mapfile -t FICHEROS < <(find . -type f \
    -not -path "./node_modules/*" -not -path "./.git/*" -not -path "./.venv/*" \
    -not -path "./sessions/*" -not -path "./certs/*" -not -path "./certs-tls/*" \
    -not -path "./media/*" -not -path "./uploads/*" -not -path "./.browser-profile/*" \
    -not -path "./backups/*" -not -path "./public/files/*" \
    -not -name "secret.json" -not -name "config.json" -not -name "links.json" \
    -not -name "check-secrets.sh")
fi
echo "· escaneando ${#FICHEROS[@]} ficheros"

escanear() {
  local patron="$1" etiqueta="$2" f
  for f in "${FICHEROS[@]}"; do
    if grep -IFn -- "$patron" "$f" >/dev/null 2>&1; then
      aviso "$etiqueta en $f"
      grep -IFn -- "$patron" "$f" | head -2 | sed 's/^/      /'
    fi
  done
}

# Rutas y identificadores personales
escanear "/home/leon" "ruta personal"
escanear "607658935800954880" "tu ID de Discord"
escanear "tail41239e" "tu tailnet"

# Secretos reales del config, buscados literalmente
if [ -f secret.json ]; then
  for campo in token webPassword; do
    valor=$(node -e "try{console.log(require('./secret.json').$campo||'')}catch(e){}" 2>/dev/null)
    [ ${#valor} -ge 6 ] && escanear "$valor" "valor de $campo"
  done
fi

# Tokens con pinta de serlo (Discord, OpenAI, Groq)
echo "· buscando tokens por forma"
for f in "${FICHEROS[@]}"; do
  if grep -IEq '(MT[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,})' "$f" 2>/dev/null; then
    aviso "posible token en $f"
  fi
done

if [ "$FALLOS" -eq 0 ]; then
  echo "✓ nada personal en lo que se publicaría"
  exit 0
fi
echo "→ $FALLOS problema(s). No publiques hasta limpiarlo."
exit 1
