# Extras: HTTPS, voz, navegador, APK, actualizar

Cosas que no vienen activadas de fábrica.

## HTTPS con certificado real (Tailscale)

El autofirmado vale para LAN, pero el móvil avisa y la PWA se queja. Con
Tailscale tienes un certificado de Let's Encrypt gratis y un nombre fijo
(aunque cambie la IP).

```bash
# 1. El equipo está en tu tailnet y con HTTPS activado en el panel de Tailscale
tailscale status
tailscale cert mi-equipo.mi-tailnet.ts.net

# 2. Deja el par en el proyecto (es lo primero que mira Lumi)
mkdir -p certs-tls
mv mi-equipo.mi-tailnet.ts.net.crt certs-tls/cert.pem
mv mi-equipo.mi-tailnet.ts.net.key certs-tls/key.pem
chmod 600 certs-tls/key.pem

# 3. Reinicia
systemctl restart lumi
```

Si Tailscale corre en Docker, el CLI está dentro del contenedor:

```bash
docker exec tailscale sh -c 'cd /tmp && tailscale cert mi-equipo.mi-tailnet.ts.net'
docker cp tailscale:/tmp/mi-equipo.mi-tailnet.ts.net.crt certs-tls/cert.pem
docker cp tailscale:/tmp/mi-equipo.mi-tailnet.ts.net.key certs-tls/key.pem
```

El certificado dura 90 días. Programa la renovación (cron mensual) con
`tailscale cert` + `systemctl restart lumi`; o usa Caddy/nginx delante y olvídate.

**Con dominio propio**: pon Caddy delante (`caddy reverse-proxy --from
lumi.tudominio.com --to 127.0.0.1:4477`) y tendrás HTTPS automático con
renovación.

## Push al móvil (ntfy)

1. Instala la app **ntfy** y suscríbete a un tema largo e imposible de adivinar
   (`lumi-leon-x7k2p9`, por ejemplo). El tema es la contraseña: cualquiera que lo
   sepa puede leer y enviar.
2. Panel → **Ajustes → Push → tema ntfy** → guardar.
3. Prueba con el botón de la sección.

Por línea de comandos:

```bash
node -e "import('./src/notify.js').then(m=>m.notify('Lumi','hola'))"
```

## Voz en los altavoces

```bash
python scripts/decir.py --list                 # dispositivos Cast
python scripts/decir.py "hola" --device Estudio
python scripts/decir.py "algo importante" --sfx alert --volume 60
scripts/alerta.sh alto "servidor caído" "Estudio" --push
```

Voces: `edge-tts` (por defecto `es-ES-AlvaroNeural`, online) con `gTTS` de
respaldo. Los tonos previos viven en `public/files/sfx/`.

Notas:

- Lumi sirve el audio por `mediaBase` (`http://IP:4477/files`): el altavoz tiene
  que poder alcanzar esa URL.
- Si el altavoz se queda en pausa al primer intento, `decir.py` reintenta.

## Navegador en vivo

Servicio aparte (Chromium con pantalla en vivo dentro del panel):

```bash
# systemd (lo deja listo install.sh)
systemctl enable --now lumi-browser
# o a mano
BROWSER_LIVE_PORT=4479 ./.venv/bin/python scripts/browser_live.py
```

Atajos desde la terminal:

```bash
scripts/web.sh search "vuelos a Roma"
scripts/web.sh open https://ejemplo.com
scripts/web.sh click "button#login"
scripts/web.sh text          # texto visible de la página
scripts/web.sh stop          # lo aparca (deja de renderizar)
```

Todo exige un token firmado que el panel pide a `/api/browser-url` y que caduca
a diario. Es un Chromium **con tus sesiones abiertas**: trátalo como tal.

## App Android

Se compila sin Gradle:

```bash
# SDK de Android + ecj
SDK=~/android-sdk
$SDK/cmdline-tools/latest/bin/sdkmanager "build-tools;34.0.0" "platforms;android-34"
curl -L -o $SDK/ecj.jar https://repo1.maven.org/maven2/org/eclipse/jdt/ecj/3.33.0/ecj-3.33.0.jar

# clave de firma (una vez) y build
keytool -genkeypair -keystore android/lumi.jks -alias lumi -keyalg RSA -keysize 2048 \
        -validity 10000 -storepass CAMBIAME -keypass CAMBIAME -dname "CN=Lumi, C=ES"
KEYSTORE_PASS=CAMBIAME ./android/build.sh
```

La app pide la URL del servidor al arrancar (no lleva ninguna escrita), así que
la misma APK sirve para cualquiera. Pulsación larga = cambiar de servidor.

## Actualizar

```bash
git pull
npm ci --omit=dev        # o npm install
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt   # si cambió
systemctl restart lumi lumi-browser
```

Con Docker: `docker compose pull || docker compose build && docker compose up -d`.
La configuración y las conversaciones viven en `./data`, así que no se tocan.

Antes de actualizar, copia `config.json`, `secret.json` y `sessions/` (o el
`./data` entero). No hay migraciones de esquema: pi lee sus JSONL tal cual.

## Desinstalar

```bash
systemctl disable --now lumi lumi-browser
rm -rf ~/lumi            # el proyecto
# y borra lo que quieras conservar antes:
#   sessions/  backups/  media/  public/files/  certs-tls/
```

Con Docker: `docker compose down -v` (ojo, `-v` borra los volúmenes) y luego
elimina la carpeta `./data` si no la quieres.
