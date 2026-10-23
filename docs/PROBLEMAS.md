# Cuando algo no va

Lo que suele pasar, por orden de frecuencia.

## El panel abre, pero al escribir dice "No API key found"

No hay clave de modelo. Lumi usa las de **pi**:

```bash
pi                 # /login o /model
cat ~/.pi/agent/auth.json
```

O pon `DEEPSEEK_API_KEY` (o la de tu proveedor) en el entorno / `.env`.
Comprueba con `lumi status` o mirando `/api/stats`.

## "No me contesta" o va lentísimo

Casi siempre es la conversación gigante: pi relee todo el historial en cada
turno. Mira el tamaño:

```bash
ls -lh sessions/*.jsonl
```

Si pasa de ~18 MB, la rotación automática debería haber actuado (mira el log:
`sesión rotada`). Si no, fuerza una conversación nueva (`/new`) y revisa
`sessionMaxMb`.

## Respuestas a medias o que desaparecen

El móvil congela la pestaña y corta el stream. La web pide la verdad al servidor
y repinta; si ves la burbuja "escribiendo…" con contador, sigue trabajando. El
historial no puede encoger: lo que ya está en pantalla no se borra.

## "Connection lost" / network error al volver a la app

Suele ser un socket keep-alive cerrado por el móvil. Se reintenta solo; si
persiste, mira que el bot siga vivo (`pm2 status` / `systemctl status lumi`).

## La app del móvil no entra (certificado)

- Si el panel va con **certificado autofirmado**, el móvil avisa. En la APK se
  acepta solo en redes privadas (192.168/10/100/127); en un dominio con
  certificado real, un fallo así **no** se acepta (sería un ataque).
- Para quitarte los avisos de encima: un certificado real de Tailscale
  (`certs-tls/`) o un dominio con Let's Encrypt.

## "address already in use" al arrancar

Otro proceso tiene el puerto:

```bash
ss -ltnp | grep -E '4477|4478|4479|4480'
```

Cambia `webPort`/`webPortHttps` o para el otro proceso.

## Chromium no arranca (navegador en vivo)

- Faltan librerías: `sudo ./.venv/bin/playwright install-deps chromium`.
- Dentro de un contenedor (root): necesita `BROWSER_LIVE_NO_SANDBOX=1`
  (el `docker-compose.yml` ya lo pone).
- El servicio es aparte del bot: `systemctl status lumi-browser` o
  `pm2 status browser-live`.

## El token del panel ha dejado de valer

Caduca a los 30 días o has cambiado el PIN (la firma se deriva de él). Vuelve a
entrar. Si te has quedado fuera: `webPassword` está en `secret.json`.

## "demasiados intentos, prueba en X min"

Freno de fuerza bruta: 5 fallos por IP → 15 minutos. Espera o reinicia el
proceso (el contador vive en memoria).

## Discord no responde

- `ownerIds` tiene que ser **tu ID numérico** (no el nombre).
- En servidores, Lumi solo contesta si el guild está en `guildAllowlist`.
- El bot necesita el **MESSAGE CONTENT INTENT** activado en el portal.
- Slash commands: si no aparecen, prueba `!help` (los globales tardan hasta 1 h
  en propagarse; también se registran por guild).

## No suena en el altavoz

- `./.venv/bin/python scripts/decir.py --list` para descubrirlos.
- El nombre del dispositivo debe coincidir con `castDevice`.
- Lumi sirve el audio por `mediaBase` (por defecto `http://TU_IP:4477/files`):
  si esa URL no es accesible desde el altavoz, no suena.

## Empiezo de cero sin perder nada

```bash
# archiva la conversación actual y empieza limpia
curl -X POST http://localhost:4477/api/new -H "Authorization: Bearer $TOKEN"
# o desde el panel: Nueva conversación
```

Lo anterior queda en `sessions/_archivo/` y en `backups/`.

## Ver qué está pasando

```bash
pm2 logs lumi --lines 100        # o: journalctl -u lumi -f
tail -f sessions/_archivo/../links.json
```
