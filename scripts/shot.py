#!/usr/bin/env python3
"""Captura el dashboard autenticado.
uso: python3 scripts/shot.py [movil|desktop] [salida.png] [ruta_opcional]
"""
import json, sys, os
from playwright.sync_api import sync_playwright

ROOT = os.environ.get("LUMI_ROOT", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
cfg = json.load(open(f"{ROOT}/config.json"))
try:
    secret = json.load(open(f"{ROOT}/secret.json"))
except Exception:
    secret = {}
passwd = cfg.get("webPassword") or secret.get("webPassword")

modo = sys.argv[1] if len(sys.argv) > 1 else "movil"
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "media", f"shot-{modo}.png")
path = sys.argv[3] if len(sys.argv) > 3 else "/"
base = os.environ.get("BASE", "http://127.0.0.1:4477")

errores = []
with sync_playwright() as p:
    b = p.chromium.launch()
    if modo == "movil":
        ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                            is_mobile=True, has_touch=True)
    else:
        ctx = b.new_context(viewport={"width": 1280, "height": 860})
    page = ctx.new_page()
    page.on("console", lambda m: m.type == "error" and errores.append(m.text))
    page.on("pageerror", lambda e: errores.append("pageerror: " + str(e)))

    page.goto(base + path, wait_until="domcontentloaded")
    if page.locator("#login").is_visible():
        page.fill("#pass", passwd)
        page.click("#loginForm button[type=submit]")
        page.wait_for_selector("#app:not(.hidden)", timeout=15000)
    page.wait_for_timeout(1800)
    page.screenshot(path=out)
    print("captura:", out)
    for e in errores[:6]:
        print("error consola:", e)
    b.close()
