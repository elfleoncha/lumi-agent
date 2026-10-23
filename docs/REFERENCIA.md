# Referencia

Todo lo que Lumi acepta y devuelve, en un sitio.

## Comandos

Sirven igual en Discord (`/comando`) y en la terminal `lumi` (salvo `/run` y
`/tts`, que son propios de Discord).

| Comando | Qué hace |
|---|---|
| `/help` | Lista de comandos |
| `/status` | Modelo, tokens, coste y tamaño del contexto |
| `/new` | Conversación nueva (archiva la anterior) |
| `/name <nombre>` | Pone nombre a la sesión actual |
| `/model` | Ver o cambiar el modelo (`proveedor/modelo`) |
| `/thinking <nivel>` | `minimal` · `low` · `medium` · `high` · `max` |
| `/compact [instrucciones]` | Compacta el contexto |
| `/session` | Info y estadísticas de la sesión |
| `/list` | Sesiones guardadas |
| `/link <sessionId>` | Enlaza esta conversación a otra sesión |
| `/linkmain` | Enlaza a la sesión principal de la terminal |
| `/skills` | Skills de pi disponibles |
| `/reload` | Recarga skills y extensiones |
| `/abort` | Cancela la respuesta en curso |
| `/tts <texto>` | Envía un texto como nota de voz |
| `/run <skill> [texto]` | Ejecuta una skill (con autocompletado) |

En Discord también funcionan como texto si el cliente no pinta los slash:
`!help`, `!status`, `!new`...

## API del panel

Todas las rutas `/api/*` (menos `login` y `health`) exigen
`Authorization: Bearer <token>`. El token se obtiene en el login y dura 30 días.

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/api/health` | Estado del proceso (sin auth, para healthchecks) |
| POST | `/api/login` | `{password}` → `{token}` |
| POST | `/api/chat` | `{text, images?}` → SSE con `delta`, `activity`, `files`, `done`, `error` |
| GET | `/api/history?limit=300` | Mensajes de la conversación |
| GET | `/api/state` | `{busy, since, file}` |
| POST | `/api/abort` | Cancela el turno en curso |
| POST | `/api/new` | Conversación nueva |
| POST | `/api/compact` | Compacta el contexto |
| GET | `/api/stats` | Modelo, tokens, coste, RAM/carga, Discord |
| GET | `/api/activity` | Actividad por día y por modelo |
| GET | `/api/commands` | Lista de comandos y skills |
| POST | `/api/command` | `{name, arg}` ejecuta un comando |
| GET/POST | `/api/settings` | Leer / guardar configuración |
| POST | `/api/settings/test` | Prueba push, Discord o voz |
| POST | `/api/upload` | Subir imagen (multipart `image`) |
| POST | `/api/transcribe` | Subir audio y transcribirlo |
| GET | `/api/browser-url` | URL del navegador en vivo con token firmado |
| GET | `/api/branding` | Nombre, tagline y colores |
| GET | `/manifest.webmanifest` | Manifest de la PWA (generado) |

Eventos del SSE de `/api/chat`:

```
data: {"type":"delta","text":"..."}          texto incremental
data: {"type":"activity","kind":"tool_start","name":"bash","args":"..."}
data: {"type":"files","files":[{"name","url","size"}]}
data: {"type":"done","text":"respuesta completa"}
data: {"type":"error","error":"..."}
```

## Configuración

`config.json` (datos) y `secret.json` (credenciales, chmod 600). Todo se puede
sobrescribir con variables de entorno, que es lo normal en Docker.

| Clave | Variable | Por defecto |
|---|---|---|
| `ownerIds` | `LUMI_OWNER_IDS` (separados por comas) | `[]` |
| `guildAllowlist` | — | `[]` |
| `sessionDir` | `LUMI_SESSION_DIR` | `./sessions` |
| `agentCwd` | `LUMI_AGENT_CWD` | tu `$HOME` |
| `maxQueue` | — | `5` |
| `webPort` | `WEB_PORT` | `4477` |
| `webPortHttps` | `WEB_PORT_HTTPS` | `4478` (`0` = sin HTTPS) |
| `browserPort` | `LUMI_BROWSER_PORT` | `4479` |
| `thinkingLevel` | `LUMI_THINKING` | `minimal` |
| `model` | `LUMI_MODEL` | el de pi |
| `castDevice` | `LUMI_CAST_DEVICE` | — |
| `castVoice` | — | `es-ES-AlvaroNeural` |
| `voiceEnabled` | — | `true` |
| `ntfyTopic` | `NTFY_TOPIC` | vacío |
| `appName` | `LUMI_NAME` | `Lumi` |
| `appTagline` | `LUMI_TAGLINE` | … |
| `sessionMaxMb` | `LUMI_SESSION_MAX_MB` | `18` (`0` = no rotar) |
| `sessionCheckMinutes` | — | `10` |
| — | `WEB_PASSWORD` | — |
| — | `DISCORD_TOKEN` | — |
| — | `LUMI_CONFIG` / `LUMI_SECRET` | rutas alternativas |
| — | `LUMI_LOG_FILE` | también escribir el log a fichero |
| — | `LUMI_NO_DISCORD` | `1` = solo panel web |

`secret.json`: `{"token": "token del bot", "webPassword": "PIN del panel"}`.

## Ficheros que crea

```
config.json  secret.json          configuración (600, fuera de git)
sessions/*.jsonl                  conversaciones (JSONL de pi)
sessions/links.json               qué conversación usa cada fichero
sessions/_archivo/                conversaciones rotadas
backups/conversacion-*.txt        volcado legible de cada rotación
media/in, media/out               adjuntos entrantes y audios generados
public/files/                     ficheros servidos al panel y a Discord
certs/  certs-tls/                certificados (autofirmado / reales)
.browser-profile/                 perfil de Chromium (cookies/sesiones)
data/                             solo en Docker: config + sesiones
```

## Idioma

La interfaz está en **español e inglés**. Se detecta con `navigator.language` la
primera vez y se cambia con el selector **ES / EN** del menú lateral (se guarda en
`localStorage`). Los mensajes del servidor (login, subidas) usan `Accept-Language`.

Para añadir un idioma: copia el bloque `en` de `public/i18n.js`, traduce los
valores y añádelo a `IDIOMAS`. Las claves son el texto original en español, así
que lo que no esté traducido se queda tal cual.
