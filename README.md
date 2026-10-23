<div align="center">

<img src="docs/img/lumi-logo.png" width="96" alt="Lumi">

# Lumi

**Tu asistente personal en casa: Discord, panel web, voz y memoria persistente.**

Un solo proceso. Un asistente. Sin base de datos, sin nube obligatoria.

</div>

![Lumi en acción](docs/img/demo.gif)

![Panel web de Lumi](docs/img/chat.png)

## Qué es

Lumi es un asistente personal autoalojado construido sobre
[pi](https://github.com/earendil-works/pi-coding-agent) (motor de agentes con
herramientas de shell, edición y lectura de ficheros). Le hablas por **Discord**
o desde un **panel web propio**, y comparte la misma conversación en los dos
sitios porque el panel corre dentro del mismo proceso que el bot.

No es un SaaS ni multiusuario: es *tu* asistente, en *tu* máquina.

## Características

**Núcleo**
- Motor de pi embebido (sin procesos hijos). Una sesión por conversación,
  persistida en JSONL: todo sobrevive a reinicios.
- Cambio de modelo y de nivel de razonamiento en caliente (`/model`, `/thinking`).
- Skills de pi invocables con `/run` y autocompletado.
- Cola secuencial por sesión: dos turnos nunca se pisan.

**Discord**
- DM y canales de guild con lista blanca de dueños.
- 16 comandos slash (con fallback por texto tipo `!help` si el cliente no los pinta).
- Imágenes entrantes (las lee), notas de voz entrantes (transcripción local con
  faster-whisper) y audios salientes (`/tts`).
- Envío de ficheros con un bloque ``` ```send``` ```.

**Panel web**
- Login con PIN, tokens firmados (HMAC) y freno de fuerza bruta.
- Chat con streaming en vivo, historial, comando `/`, adjuntar imágenes y dictado.
- Botón de **cancelar** que aborta de verdad lo que está haciendo, también al
  volver a la app (burbuja "escribiendo…" con contador).
- Consumo (tokens y coste), contexto, RAM/carga, actividad por día y por modelo.
- Ajustes desde la propia web: marca, Discord, modelo, puertos y HTTPS, voz, push.
- PWA instalable en el móvil.

**Voz y casa**
- Habla por Chromecast / Nest con edge-tts o gTTS, con tonos previos y volumen.
- Alertas con push al móvil (ntfy).

**App Android (opcional)**
- Cliente WebView con **URL configurable**: la primera vez pide la dirección del
  servidor y la guarda; se cambia manteniendo pulsada la pantalla.
- Descargas con `DownloadManager`, selector de ficheros, micrófono y
  certificado autofirmado aceptado **solo** en redes privadas.
- Código en `android/`; se compila sin Gradle con `KEYSTORE_PASS=... ./android/build.sh`.

**Extras**
- **Navegador en vivo**: Chromium persistente con pantalla en vivo embebida en el
  panel y control por API (goto, click, fill, text...). Protegido con token.
- **Terminal propia**: `lumi` (sin dependencias), `lumi ask "..."`, `lumi status`.
- APK Android opcional (WebView) para tenerlo como app.

## Instalación rápida

Requisitos: **Node 20+** y una clave de API de un modelo. Opcionalmente
**ffmpeg** + Python para voz y navegador.

### 1. Configurar el modelo (lo primero)

Lumi no trae claves: usa las de **pi**, el motor que lleva dentro. Se configuran
una vez, en tu máquina:

```bash
npm i -g @earendil-works/pi-coding-agent   # o el instalador de pi que prefieras
pi                                          # dentro, /login o /model para elegir proveedor
cat ~/.pi/agent/auth.json                   # aquí quedan las credenciales
```

Lumi lee `~/.pi/agent/auth.json` al arrancar. Si no hay ninguna clave, el panel
abre pero al escribir el primer mensaje sale "No API key found".

La alternativa (y la única fiable en Docker) es una **variable de entorno**:

```bash
export DEEPSEEK_API_KEY=sk-...
# o OPENAI_API_KEY, GROQ_API_KEY...
```

### 2. Instalar Lumi

```bash
git clone https://github.com/elfleoncha/lumi-agent.git
cd lumi
./install.sh          # instala deps, crea config/secret y un certificado propio
```

O a mano:

```bash
npm install

cp config.example.json config.json
cp secret.example.json secret.json   # y pon dentro tu token y tu PIN
# edita config.json: ownerIds (tu ID de Discord), appName, puertos...

npm start                 # con Discord
LUMI_NO_DISCORD=1 npm start   # solo panel web
```

Abre `http://localhost:4477` y entra con el `webPassword` de `secret.json`.
El instalador también genera un certificado autofirmado en `certs/`, así que
`https://localhost:4478` funciona para el micrófono y la PWA.

### 3. Arrancarlo siempre

Con Docker (lo más cómodo):

```bash
cp config.example.json config.json && cp secret.example.json secret.json
# edita los dos y luego:
docker compose up -d
```

Con systemd:

```bash
./install.sh            # copia, crea .venv y deja listo el servicio
sudo systemctl enable --now lumi
```

## Configuración

Todo vive en `config.json` y `secret.json` (ambos **fuera de git**).

| Clave | Para qué |
|---|---|
| `ownerIds` | IDs de Discord con permiso (tú) |
| `guildAllowlist` | Servidores donde puede responder; vacío = solo DM |
| `sessionDir` | Dónde se guardan las conversaciones |
| `agentCwd` | Directorio de trabajo del agente |
| `webPort` / `webPortHttps` | Puertos del panel (4477 / 4478; `0` = sin HTTPS) |
| `browserPort` | Navegador en vivo (4479, y +1 para HTTPS) |
| `thinkingLevel` | `minimal` ahorra tokens; `high` razona más |
| `castDevice` / `castVoice` | Altavoz por defecto y voz de Cast |
| `ntfyTopic` | Canal de push al móvil |
| `appName` / `appTagline` | Marca que se ve en la web |
| `sessionMaxMb` | A partir de cuántos MB se rota la conversación (18 por defecto, `0` lo apaga) |
| `sessionCheckMinutes` | Cada cuánto se revisa el tamaño (10 min) |

`secret.json`: `token` (bot de Discord) y `webPassword` (PIN del panel).

## Comandos

En Discord y en la terminal `lumi`:

```
/help     comandos disponibles        /model    ver o cambiar modelo
/status   modelo, tokens y coste      /thinking nivel de razonamiento
/new      conversación nueva          /compact  compactar contexto
/session  info de la sesión           /list     sesiones guardadas
/skills   skills disponibles          /run      ejecutar una skill
/abort    cancelar la respuesta       /tts      enviar una nota de voz
```

## Capturas

| | |
|---|---|
| ![Resumen](docs/img/dashboard.png) | ![Ajustes](docs/img/ajustes.png) |
| ![Móvil](docs/img/movil.png) | ![Terminal](docs/img/terminal.png) |

## Sesiones largas (por qué se rotan solas)

Compactar el contexto **añade** entradas al JSONL, nunca borra: el fichero solo
crece. Con 30-40 MB el modelo tiene que releerlo entero en cada turno y todo
parece colgado. Por eso Lumi vigila el tamaño cada 10 minutos y, si pasa de
`sessionMaxMb`, archiva el fichero en `sessions/_archivo/`, guarda un volcado
legible en `backups/` y sigue con una conversación limpia **sin reiniciar**.

La conversación anterior no se pierde: queda en texto plano y puedes releerla.

## Docker

Incluye `Dockerfile` y `docker-compose.yml` (panel, ffmpeg y venv dentro).

```bash
cp .env.example .env        # pon DEEPSEEK_API_KEY (o la de tu proveedor)
docker compose up -d
docker compose logs -f
```

Las credenciales van por **variable de entorno**, no montando `~/.pi`: dentro de
un contenedor limpio el SDK no siempre encuentra el `auth.json` (probado, es lo
que falla primero). Si aun así lo prefieres, el `docker-compose.yml` tiene la
línea comentada.

## Pruebas

```bash
npm run lint            # sintaxis de los ficheros principales
npm run check:secrets   # nada personal en el repo
./scripts/smoke-test.sh # arranca en un puerto libre y comprueba salud, login y auth
```

GitHub Actions ejecuta las tres en cada push (Node 20 y 22).

## Seguridad (leer antes de exponerlo)

- El panel está pensado para **LAN o Tailscale**, no para internet abierto. Si lo
  publicas, ponlo detrás de un proxy con autenticación (Cloudflare Access, etc.).
- **Lumi ejecuta comandos como el usuario que lo arranca.** Quien tenga el PIN
  tiene shell. Aíslalo con un usuario propio, contenedor o `systemd` con
  `ProtectSystem`/`ProtectHome` si te preocupa.
- El **navegador en vivo** controla un Chromium con tus sesiones abiertas: exige
  token firmado y caduca a diario.
- Los tokens del panel viajan solo en la cabecera `Authorization`, nunca en URLs.
- HTTPS: puedes usar un certificado propio (`certs/`) o uno real de Tailscale
  (`certs-tls/`, Let's Encrypt) — el bot prefiere el segundo.
- `npm run check:secrets` antes de publicar: busca rutas personales, IDs y
  tokens filtrados.

## Estructura

```
android/    app Android (WebView, configurable)
src/        servidor: bot de Discord, panel web, sesiones, media, voz
public/     panel web (vanilla JS, sin build)
bin/        terminal `lumi`
scripts/    voz, navegador en vivo, transcripción, utilidades
docs/       capturas
deploy/     unidad systemd de ejemplo
```

## Créditos

Construido sobre [pi](https://github.com/earendil-works/pi-coding-agent) (MIT).
El resto, MIT también: haz lo que quieras con él.
