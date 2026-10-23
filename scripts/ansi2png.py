#!/usr/bin/env python3
"""Convierte la captura de tmux (con colores ANSI) en un PNG con aspecto de terminal."""
import html
import os
import re
import subprocess
import sys

NAME = sys.argv[1] if len(sys.argv) > 1 else "lumi-demo"
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "files", "lumi-terminal.png")

raw = subprocess.run(
    ["tmux", "capture-pane", "-p", "-e", "-t", NAME], capture_output=True, text=True
).stdout

# paleta xterm-256 (los 16 primeros y los grises/colores que usa lumi)
BASE16 = [
    "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
    "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
]


def c256(n):
    if n < 16:
        return BASE16[n]
    if n < 232:
        n -= 16
        r, g, b = n // 36, (n % 36) // 6, n % 6
        paso = [0, 95, 135, 175, 215, 255]
        return f"#{paso[r]:02x}{paso[g]:02x}{paso[b]:02x}"
    v = 8 + (n - 232) * 10
    return f"#{v:02x}{v:02x}{v:02x}"


SGR = re.compile(r"\x1b\[([0-9;]*)m")
OTROS = re.compile(r"\x1b\[[0-9;?]*[A-LN-Za-ln-z]")  # CSI que NO es SGR (no acaba en m)


def linea_a_html(linea):
    """ANSI SGR -> spans. Soporta 0/1/2/22, 30-37/90-97, 38;5;N y 38;2;r;g;b."""
    est = {"color": None, "dim": False, "bold": False}
    salida, pos = [], 0

    def emitir(texto):
        if not texto:
            return
        clases, estilo = [], ""
        if est["bold"]:
            clases.append("b")
        if est["dim"]:
            clases.append("d")
        if est["color"]:
            estilo = f' style="color:{est["color"]}"'
        if clases or estilo:
            salida.append(f'<span class="{" ".join(clases)}"{estilo}>{html.escape(texto)}</span>')
        else:
            salida.append(html.escape(texto))

    for m in SGR.finditer(linea):
        emitir(linea[pos:m.start()])
        pos = m.end()
        cods = [c for c in (m.group(1) or "0").split(";") if c != ""] or ["0"]
        i = 0
        while i < len(cods):
            c = cods[i]
            if c == "0":
                est = {"color": None, "dim": False, "bold": False}
            elif c == "1":
                est["bold"] = True
            elif c == "2":
                est["dim"] = True
            elif c == "22":
                est["bold"] = est["dim"] = False
            elif c == "39":
                est["color"] = None
            elif c == "38" and i + 2 < len(cods) and cods[i + 1] == "5":
                est["color"] = c256(int(cods[i + 2]))
                i += 2
            elif c == "38" and i + 4 < len(cods) and cods[i + 1] == "2":
                r, g, b = (int(cods[i + 2]), int(cods[i + 3]), int(cods[i + 4]))
                est["color"] = f"#{r:02x}{g:02x}{b:02x}"
                i += 4
            elif c.isdigit() and 30 <= int(c) <= 37:
                est["color"] = c256(int(c) - 30)
            elif c.isdigit() and 90 <= int(c) <= 97:
                est["color"] = c256(int(c) - 90 + 8)
            i += 1
    resto = linea[pos:]
    resto = OTROS.sub("", resto)
    emitir(resto)
    return "".join(salida)


lineas = [OTROS.sub("", l) for l in raw.splitlines()]
while lineas and not lineas[-1].strip():
    lineas.pop()
cuerpo = "\n".join(linea_a_html(l) for l in lineas)

HTML = f"""<!doctype html><html><head><meta charset="utf-8"><style>
  html,body {{ margin:0; background:transparent; }}
  .win {{ display:inline-block; padding:18px 20px 20px; border-radius:14px;
          background:linear-gradient(160deg,#12121a,#0a0a0f 60%);
          border:1px solid rgba(167,139,250,.22);
          box-shadow:0 24px 60px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.04); }}
  .bar {{ display:flex; gap:7px; align-items:center; margin:0 0 14px; }}
  .dot {{ width:11px; height:11px; border-radius:50%; }}
  .r {{ background:#ff5f57 }} .y {{ background:#febc2e }} .g {{ background:#28c840 }}
  .t {{ margin-left:10px; color:#6b6678; font:12px ui-monospace,monospace; }}
  pre {{ margin:0; color:#f6f5fa;
         font:13.5px/1.55 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }}
  .b {{ font-weight:700 }} .d {{ opacity:.62 }}
</style></head><body>
<div class="win">
  <div class="bar"><i class="dot r"></i><i class="dot y"></i><i class="dot g"></i>
    <span class="t">lumi — leon@fleoserv</span></div>
  <pre>{cuerpo}</pre>
</div></body></html>"""

from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 900, "height": 460}, device_scale_factor=2)
    pg.set_content(HTML)
    pg.wait_for_timeout(300)
    pg.locator(".win").screenshot(path=OUT, omit_background=True)
    b.close()

print("guardado en", OUT)
