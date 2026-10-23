#!/usr/bin/env python3
"""
Haz hablar a un altavoz Cast (Nest Mini / Nest Hub / TV).

uso:
  .venv/bin/python scripts/decir.py "Hola Leon"                 # altavoz por defecto
  .venv/bin/python scripts/decir.py --device "Estudio" "texto"
  .venv/bin/python scripts/decir.py --list                      # lista dispositivos
  .venv/bin/python scripts/decir.py --all "aviso para toda la casa"
  .venv/bin/python scripts/decir.py --volume 0.6 --device Estudio "texto"

El audio se genera con gTTS, se sirve desde el dashboard (public/files) y se
lanza por Cast; el altavoz lo descarga de la red local.
"""
import argparse
import json
import logging
import pathlib
import os
import sys
import time

logging.getLogger("pychromecast").setLevel(logging.ERROR)

ROOT = os.environ.get("LUMI_ROOT", str(pathlib.Path(__file__).resolve().parent.parent))
PUBLIC = f"{ROOT}/public/files"
# URL desde la que el altavoz descarga el audio (IP de la máquina en la LAN)
def _media_base() -> str:
    """URL que el altavoz usará para descargar el audio (IP de la LAN)."""
    env = os.environ.get("LUMI_MEDIA_BASE")
    if env:
        return env
    try:
        cfg = json.load(open(os.path.join(ROOT, "config.json"), encoding="utf-8"))
        if cfg.get("mediaBase"):
            return cfg["mediaBase"]
        puerto = cfg.get("webPort", 4477)
    except Exception:
        puerto = 4477
    return f"http://{os.environ.get('LUMI_HOST', '127.0.0.1')}:{puerto}/files"


BASE_URL = _media_base()
DEFAULT_DEVICE = os.environ.get("LUMI_CAST_DEVICE", "Salon")


def listar(casts):
    for c in casts:
        print(f"- {c.friendly_name}  ({c.model_name})  {c.host}")


SFX_DIR = f"{ROOT}/public/files/sfx"


def con_efecto(mp3_tts: str, sfx: str) -> str:
    """Pega el efecto de sonido delante de la voz (un solo mp3, una sola reproducción)."""
    import subprocess

    efecto = os.path.join(SFX_DIR, f"{sfx}.mp3")
    if not os.path.exists(efecto):
        return mp3_tts
    mp3_tts = os.path.join(PUBLIC, os.path.basename(mp3_tts))
    salida = mp3_tts.replace(".mp3", f"-{sfx}.mp3")
    try:
        subprocess.run(
            [
                os.environ.get("LUMI_FFMPEG", "ffmpeg"), "-hide_banner", "-loglevel", "error", "-y",
                "-i", efecto, "-i", mp3_tts,
                "-filter_complex", "[0][1]concat=n=2:v=0:a=1",
                "-ar", "44100", salida,
            ],
            check=True,
            timeout=30,
        )
        os.remove(mp3_tts)
        return salida
    except Exception as e:
        print("aviso: no pude añadir el efecto:", e, file=sys.stderr)
        return mp3_tts


VOZ = os.environ.get("CAST_VOICE", "es-ES-AlvaroNeural")


def tts_mp3(texto: str, voz: str | None = None) -> str:
    os.makedirs(PUBLIC, exist_ok=True)
    # limpia los mp3 de TTS de más de 1 hora
    ahora = time.time()
    for f in os.listdir(PUBLIC):
        if f.startswith("tts-") and f.endswith(".mp3"):
            ruta_vieja = os.path.join(PUBLIC, f)
            try:
                if ahora - os.path.getmtime(ruta_vieja) > 3600:
                    os.remove(ruta_vieja)
            except OSError:
                pass
    nombre = f"tts-{int(time.time() * 1000)}.mp3"
    ruta = os.path.join(PUBLIC, nombre)
    voz = voz or VOZ

    # 1º edge-tts (voces neuronales, Álvaro = masculina)
    try:
        import asyncio

        import edge_tts

        async def _gen():
            com = edge_tts.Communicate(texto, voz, rate="+4%")
            await com.save(ruta)

        asyncio.run(_gen())
        if os.path.getsize(ruta) > 1000:
            return nombre
    except Exception as e:
        print("aviso: edge-tts falló, uso gTTS:", e, file=sys.stderr)

    # 2º fallback: gTTS
    from gtts import gTTS

    if os.path.exists(ruta):
        os.remove(ruta)
    gTTS(text=texto, lang="es").save(ruta)
    return nombre


def enviar(destinos, texto, volumen, zconf, sfx=None, voz=None):
    from pychromecast import get_chromecast_from_cast_info

    nombre = tts_mp3(texto, voz)
    if sfx:
        nombre = con_efecto(nombre, sfx)
    url = f"{BASE_URL}/{nombre}"
    for info in destinos:
        cast = None
        try:
            cast = get_chromecast_from_cast_info(info, zconf, timeout=12)
            cast.wait(timeout=15)
            if volumen is not None:
                cast.set_volume(volumen)
            mc = cast.media_controller
            ok = False
            ultimo_error = None
            for intento in range(2):
                try:
                    mc.play_media(url, "audio/mpeg")
                    mc.block_until_active(timeout=10)
                    ok = True
                    break
                except Exception as e:
                    ultimo_error = e
                    time.sleep(1.0)
            estado = ""
            try:
                mc.update_status()
                time.sleep(0.4)
                estado = mc.status.player_state
                if estado in ("PLAYING", "BUFFERING", "PAUSED"):
                    ok = True
            except Exception:
                pass
            if not ok and ultimo_error:
                raise ultimo_error
            extra = f" [{estado}]" if estado else ""
            print(("→ " if ok else "⚠ ") + f"{info.friendly_name}: {texto[:50]}{extra}")
        except Exception as e:
            print(f"✗ {info.friendly_name}: {e}", file=sys.stderr)
    # deja tiempo a que suene antes de salir
    time.sleep(1.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("texto", nargs="*", help="lo que debe decir")
    ap.add_argument("--device", default=DEFAULT_DEVICE, help="nombre del altavoz")
    ap.add_argument("--all", action="store_true", help="todos los altavoces")
    ap.add_argument("--volume", type=float, default=None, help="0.0 - 1.0")
    ap.add_argument("--voz", default=None, help="voz edge-tts (ej. es-ES-AlvaroNeural)")
    ap.add_argument("--list", action="store_true", help="lista dispositivos")
    ap.add_argument("--sin-sfx", action="store_true", help="hablar sin tono previo")
    ap.add_argument(
        "--sfx",
        default="tintin",
        choices=["ok", "success", "alert", "error", "chime", "tintin"],
        help="efecto de sonido antes de hablar",
    )
    args = ap.parse_args()

    from zeroconf import Zeroconf
    from pychromecast import discovery

    zconf = Zeroconf()
    try:
        infos, browser = discovery.discover_chromecasts(
            timeout=12, zeroconf_instance=zconf
        )
        casts = infos

        if args.list or not args.texto:
            listar(casts)
            return

        texto = " ".join(args.texto)
        if args.all:
            destinos = [c for c in casts if "Nest" in (c.model_name or "")]
        else:
            destinos = [c for c in casts if c.friendly_name.lower() == args.device.lower()]
            if not destinos:
                destinos = [c for c in casts if args.device.lower() in c.friendly_name.lower()]
        if not destinos:
            print(f"no encuentro '{args.device}'. Disponibles:", file=sys.stderr)
            listar(casts)
            sys.exit(1)

        sfx = None if args.sin_sfx else args.sfx
        enviar(destinos, texto, args.volume, zconf, sfx, args.voz)
        time.sleep(2.5)
    finally:
        try:
            discovery.stop_discovery(browser)
        except Exception:
            pass
        zconf.close()


if __name__ == "__main__":
    main()
