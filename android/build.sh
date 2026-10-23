#!/bin/bash
# Compila la APK de Lumi (sin Gradle: aapt2 + ecj + d8 + apksigner).
#
#   ./android/build.sh
#
# Variantes (útil para reemplazar una app ya instalada conservando su paquete):
#   PAQUETE=com.lumi.client NOMBRE=Lumi ./android/build.sh
#   PAQUETE=com.leon.minivalen NOMBRE=MiniValen SALIDA=public/files/MiniValen.apk ./android/build.sh
#
# Necesita el SDK de Android (build-tools 34.0.0 y platforms/android-34) y
# `ecj.jar` (compilador de Eclipse, sirve sin JDK completo):
#
#   SDK=~/android-sdk
#   $SDK/cmdline-tools/latest/bin/sdkmanager "build-tools;34.0.0" "platforms;android-34"
#   curl -L -o $SDK/ecj.jar https://repo1.maven.org/maven2/org/eclipse/jdt/ecj/3.33.0/ecj-3.33.0.jar
#
# La clave de firma es tuya: si no existe, el script te dice cómo crearla.
set -euo pipefail
SDK="${SDK:-$HOME/android-sdk}"
BT="$SDK/build-tools/34.0.0"
PLAT="$SDK/platforms/android-34/android.jar"
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
PROY="$RAIZ/android"
PAQUETE="${PAQUETE:-com.lumi.client}"
NOMBRE="${NOMBRE:-Lumi}"
OUT="${RAIZ}/${SALIDA:-public/files/Lumi.apk}"
KS="${KEYSTORE:-$PROY/lumi.jks}"

[ -f "$PLAT" ] || { echo "Falta $PLAT (instala platforms;android-34)" >&2; exit 1; }
[ -f "$SDK/ecj.jar" ] || { echo "Falta $SDK/ecj.jar (compilador)" >&2; exit 1; }

if [ ! -f "$KS" ]; then
  cat >&2 <<EOF
No encuentro la clave de firma: $KS

Genera la tuya (una sola vez) y vuelve a lanzar:
  keytool -genkeypair -keystore "$PROY/lumi.jks" -alias lumi \\
          -keyalg RSA -keysize 2048 -validity 10000 \\
          -storepass CAMBIAME -keypass CAMBIAME \\
          -dname "CN=Lumi, O=TuNombre, C=ES"

Luego, para firmar:
  KEYSTORE_PASS=CAMBIAME ./android/build.sh
EOF
  exit 1
fi

# Copia de trabajo: así se puede cambiar el paquete sin tocar el código fuente.
TRABAJO="$(mktemp -d)"
trap 'rm -rf "$TRABAJO"' EXIT
cp -r "$PROY"/src "$PROY"/res "$PROY"/AndroidManifest.xml "$TRABAJO"/
cd "$TRABAJO"

if [ "$PAQUETE" != "com.lumi.client" ]; then
  echo "· variante $PAQUETE ($NOMBRE)"
  RUTA_PAQUETE="$(echo "$PAQUETE" | tr '.' '/')"
  mkdir -p "src/$RUTA_PAQUETE"
  mv src/com/lumi/client/*.java "src/$RUTA_PAQUETE"/
  rm -rf src/com/lumi
  sed -i "s/^package com\.lumi\.client;/package $PAQUETE;/" "src/$RUTA_PAQUETE"/*.java
  sed -i "s|package=\"com.lumi.client\"|package=\"$PAQUETE\"|; \
          s|android:name=\"com.lumi.client.MainActivity\"|android:name=\"$PAQUETE.MainActivity\"|; \
          s|android:label=\"Lumi\"|android:label=\"$NOMBRE\"|" AndroidManifest.xml
fi

rm -rf gen classes dex res.zip base.apk aligned.apk
mkdir -p gen classes dex "$(dirname "$OUT")"

echo "· recursos"
"$BT/aapt2" compile --dir res -o res.zip
"$BT/aapt2" link -o base.apk -I "$PLAT" --manifest AndroidManifest.xml \
  --java gen --auto-add-overlay res.zip

echo "· java (ecj)"
java -jar "$SDK/ecj.jar" -source 1.8 -target 1.8 -nowarn -proceedOnError \
  -cp "$PLAT" -d classes $(find src gen -name "*.java")

echo "· dex (d8)"
"$BT/d8" --lib "$PLAT" --min-api 24 --output dex $(find classes -name "*.class")
(cd dex && zip -q ../base.apk classes.dex)

echo "· alinear y firmar"
"$BT/zipalign" -f 4 base.apk aligned.apk
"$BT/apksigner" sign --ks "$KS" \
  --ks-pass "pass:${KEYSTORE_PASS:?define KEYSTORE_PASS}" \
  --key-pass "pass:${KEYSTORE_PASS}" --out "$OUT" aligned.apk
"$BT/apksigner" verify --print-certs "$OUT" | head -3

echo "· listo: $OUT ($(du -h "$OUT" | cut -f1))"
