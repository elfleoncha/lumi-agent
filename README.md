<div align="center">

<img src="docs/img/lumi-logo.png" width="96" alt="Lumi">

# Lumi

**Tu asistente personal en casa: Discord, panel web, voz y memoria persistente.**

Un solo proceso. Un asistente. Sin base de datos, sin nube obligatoria.

</div>

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

**Extras**
- **Navegador en vivo**: Chromium persistente con pantalla en vivo embebida en el
  panel y control por API (goto, click, fill, text...). Protegido con token.
- **Terminal propia**: `lumi` (sin dependencias), `lumi ask "..."`, `lumi status`.
- APK Android opcional (WebView) para tenerlo como app.

## Instalación rápida

Requisitos: **Node 20+**, una clave de API para el modelo (DeepSeek, Groq,
OpenAI...) configurada en pi, y opcionalmente **ffmpeg** + Python para voz.

```bash
git clone https://github.com/<tu-usuario>/lumi.git
cd lumi
npm install

cp config.example.json config.json
cp secret.example.json secret.json   # y pon dentro tu token y tu PIN
# edita config.json: ownerIds (tu ID de Discord), appName, puertos...

npm start                 # con Discord
LUMI_NO_DISCORD=1 npm start   # solo panel web
```

Abre `http://localhost:4477` y entra con el `webPassword` de `secret.json`.

Con `install.sh` se genera además el servicio systemd:

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
