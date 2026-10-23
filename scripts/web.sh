#!/bin/bash
# Atajos para el navegador en vivo (servicio PM2 "browser-live", puerto 4479).
# uso:
#   scripts/web.sh search "consulta"     busca en Brave (salta el "Verificar")
#   scripts/web.sh open https://url      abre una URL
#   scripts/web.sh click SELECTOR|X,Y    clic por selector o coordenadas
#   scripts/web.sh text                  texto visible de la página
#   scripts/web.sh url                   URL actual
#   scripts/web.sh stop                  aparca el navegador (deja de renderizar)
set -u
# El servicio exige token firmado (mismo secreto que la web, caduca a diario).
TOKEN=$(node -e '
const c=require("crypto"),fs=require("fs");
const s=JSON.parse(fs.readFileSync(process.env.LUMI_SECRET||(process.env.HOME+"/valen-bot/secret.json"),"utf8"));
const key=c.createHash("sha256").update(String(s.webPassword)+"::valen").digest();
console.log(c.createHmac("sha256",key).update("browser:"+new Date().toISOString().slice(0,10)).digest("hex"));
' 2>/dev/null)
API="http://127.0.0.1:4479/do?token=${TOKEN}"
cmd="${1:-}"; shift || true

post() { curl -s --max-time 60 -X POST -H "Content-Type: application/json" -d "$1" "$API"; echo; }

case "$cmd" in
  search) post "{\"action\":\"search\",\"q\":\"$*\"}" ;;
  open)   post "{\"action\":\"goto\",\"url\":\"$1\",\"wait\":\"domcontentloaded\"}" ;;
  click)
    if [[ "$1" == *,* ]]; then
      x="${1%,*}"; y="${1#*,}"; post "{\"action\":\"click\",\"x\":$x,\"y\":$y}"
    else
      post "{\"action\":\"click\",\"selector\":\"$1\"}"
    fi ;;
  text) post '{"action":"text"}' ;;
  url)  post '{"action":"url"}' ;;
  stop) post '{"action":"stop"}' ;;
  *) echo "uso: $0 search|open|click|text|url|stop ..."; exit 1 ;;
esac
