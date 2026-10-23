#!/usr/bin/env python3
"""
Mini-servicio de navegador en vivo.

- Mantiene un Chromium (Playwright) con una página.
- Emite la pantalla como MJPEG en /stream y el cursor por WebSocket en /ws.
- Se controla por HTTP en /do (goto, move, click, type, scroll, key, shot).

Así Leon puede abrir http://<ip>:4479 y ver en tiempo real el ratón moviéndose,
los clics y la navegación, igual que una pantalla remota.
"""
import asyncio
import datetime
import hashlib
import hmac
import json
import io
import urllib.parse
import json
import os
import time

from aiohttp import web, WSMsgType
from playwright.async_api import async_playwright

PORT = int(os.environ.get("BROWSER_LIVE_PORT", "4479"))
VIEW_W, VIEW_H = 1280, 800
FPS = 8
START_URL = os.environ.get("BROWSER_LIVE_START", "http://127.0.0.1:4477/")

state = {
    "page": None,
    "browser": None,
    "context": None,
    "cursor": {"x": VIEW_W // 2, "y": VIEW_H // 2},
    "clients": set(),
    "lock": asyncio.Lock(),
    "last_frame": None,
    "url": "about:blank",
    "last_action": time.time(),
    "idle": False,
}


async def broadcast(msg: dict):
    data = json.dumps(msg)
    for ws in list(state["clients"]):
        try:
            await ws.send_str(data)
        except Exception:
            state["clients"].discard(ws)


async def grab_frame():
    page = state["page"]
    try:
        png = await page.screenshot(type="jpeg", quality=55)
        return png
    except Exception:
        return None


async def stream_handler(request):
    resp = web.StreamResponse(
        headers={
            "Content-Type": "multipart/x-mixed-replace; boundary=frame",
            "Cache-Control": "no-store",
            "Pragma": "no-cache",
        }
    )
    await resp.prepare(request)
    try:
        while True:
            # sin espectadores conectados por WS: no se captura nada
            if not state["clients"] and state["idle"]:
                if state["last_frame"]:
                    await resp.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ")
                    await resp.write(str(len(state["last_frame"])).encode())
                    await resp.write(b"\r\n\r\n")
                    await resp.write(state["last_frame"])
                    await resp.write(b"\r\n")
                await asyncio.sleep(2)
                continue
            jpg = await grab_frame()
            if jpg:
                state["last_frame"] = jpg
                await resp.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ")
                await resp.write(str(len(jpg)).encode())
                await resp.write(b"\r\n\r\n")
                await resp.write(jpg)
                await resp.write(b"\r\n")
            await asyncio.sleep(1 / FPS)
    except (ConnectionResetError, asyncio.CancelledError):
        pass
    return resp


async def ws_handler(request):
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    state["clients"].add(ws)
    state["last_action"] = time.time()
    if state["idle"] or state["page"].url == "about:blank":
        state["idle"] = False
        try:
            await state["page"].goto(START_URL, wait_until="domcontentloaded", timeout=15000)
            state["url"] = state["page"].url
        except Exception:
            pass
    state["idle"] = False
    await ws.send_str(json.dumps({"cursor": state["cursor"], "url": state["url"]}))
    try:
        async for msg in ws:
            if msg.type == WSMsgType.ERROR:
                break
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except Exception:
                continue
            page = state["page"]
            state["last_action"] = time.time()
            state["idle"] = False
            try:
                if "click" in data:
                    c = data["click"]
                    await move_cursor(c["x"], c["y"], steps=6)
                    await broadcast({"click": state["cursor"]})
                    await page.mouse.click(state["cursor"]["x"], state["cursor"]["y"])
                elif "text" in data:
                    await page.keyboard.type(str(data["text"]), delay=25)
                    if data.get("key"):
                        await page.keyboard.press(str(data["key"]))
                elif "key" in data:
                    await page.keyboard.press(str(data["key"]))
                elif "scroll" in data:
                    await page.mouse.wheel(0, int(data["scroll"]))
            except Exception as e:
                print("ws acción:", e, flush=True)
    finally:
        state["clients"].discard(ws)
        state["last_action"] = time.time()
    return ws


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


async def move_cursor(x, y, steps=10, delay=0.018):
    """Mueve el ratón interpolando para que el movimiento se vea fluido."""
    x, y = clamp(int(x), 0, VIEW_W - 1), clamp(int(y), 0, VIEW_H - 1)
    cur = state["cursor"]
    x0, y0 = cur["x"], cur["y"]
    for i in range(1, steps + 1):
        nx = x0 + (x - x0) * i / steps
        ny = y0 + (y - y0) * i / steps
        try:
            await state["page"].mouse.move(nx, ny)
        except Exception:
            pass
        state["cursor"] = {"x": round(nx), "y": round(ny)}
        await broadcast({"cursor": state["cursor"]})
        await asyncio.sleep(delay)


async def do_action(payload):
    page = state["page"]
    act = payload.get("action")

    if act == "goto":
        url = payload["url"]
        await page.goto(url, wait_until=payload.get("wait", "domcontentloaded"), timeout=30000)
        state["url"] = page.url
        await broadcast({"url": state["url"]})
        return {"ok": True, "url": await page.url if False else page.url}

    if act == "move":
        await move_cursor(payload["x"], payload["y"], steps=payload.get("steps", 10))
        return {"ok": True}

    if act == "click":
        if "x" in payload:
            await move_cursor(payload["x"], payload["y"])
            await broadcast({"click": state["cursor"]})
            await page.mouse.click(state["cursor"]["x"], state["cursor"]["y"])
            return {"ok": True}
        sel = payload["selector"]
        box = await page.locator(sel).first.bounding_box()
        if not box:
            return {"ok": False, "error": "no encontrado"}
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        await move_cursor(cx, cy)
        await broadcast({"click": state["cursor"]})
        await page.mouse.click(cx, cy)
        return {"ok": True, "at": {"x": cx, "y": cy}}

    if act == "click_text":
        loc = page.get_by_text(payload["text"]).first
        box = await loc.bounding_box()
        if box:
            await move_cursor(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            await broadcast({"click": state["cursor"]})
        await loc.click()
        return {"ok": True}

    if act == "fill":
        await page.fill(payload["selector"], payload.get("text", ""))
        return {"ok": True}

    if act == "type":
        text = payload.get("text", "")
        await page.keyboard.type(text, delay=payload.get("delay", 45))
        return {"ok": True}

    if act == "key":
        await page.keyboard.press(payload["key"])
        return {"ok": True}

    if act == "drag":
        x1, y1 = payload["x1"], payload["y1"]
        x2, y2 = payload["x2"], payload["y2"]
        await move_cursor(x1, y1, steps=6)
        await page.mouse.down()
        pasos = payload.get("steps", 24)
        for i in range(1, pasos + 1):
            nx = x1 + (x2 - x1) * i / pasos
            ny = y1 + (y2 - y1) * i / pasos
            await page.mouse.move(nx, ny)
            state["cursor"] = {"x": round(nx), "y": round(ny)}
            await broadcast({"cursor": state["cursor"]})
            await asyncio.sleep(0.02)
        await page.mouse.up()
        return {"ok": True}

    if act == "scroll":
        await page.mouse.wheel(0, payload.get("dy", 400))
        return {"ok": True}

    if act == "text":
        return {"ok": True, "text": (await page.inner_text("body"))[:4000]}

    if act == "search":
        # busca en Brave (es el único que no nos bloquea) y salta el chequeo si aparece
        q = payload["q"]
        await page.goto(f"https://search.brave.com/search?q={urllib.parse.quote(q)}",
                        wait_until="domcontentloaded", timeout=30000)
        for _ in range(6):
            try:
                if await page.get_by_text("Verificar", exact=False).first.is_visible():
                    await page.get_by_text("Verificar", exact=False).first.click()
                    await page.wait_for_timeout(2500)
                    continue
            except Exception:
                pass
            break
        state["url"] = page.url
        await broadcast({"url": state["url"]})
        return {"ok": True, "url": page.url}

    if act == "stop":
        # fin de la tarea: se aparca y deja de renderizar
        state["idle"] = True
        state["last_frame"] = None
        try:
            await page.goto("about:blank")
        except Exception:
            pass
        await broadcast({"url": "about:blank"})
        return {"ok": True, "stopped": True}

    if act == "url":
        return {"ok": True, "url": await page.url if False else page.url}

    return {"ok": False, "error": f"acción desconocida: {act}"}


async def do_handler(request):
    payload = await request.json()
    state["last_action"] = time.time()
    state["idle"] = False
    async with state["lock"]:
        try:
            return web.json_response(await do_action(payload))
        except Exception as e:
            return web.json_response({"ok": False, "error": str(e)}, status=500)


VIEWER = """<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Navegador de Valen</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0a0a0f; color:#f6f5fa; font:14px -apple-system,system-ui,sans-serif; }
  header { display:flex; gap:10px; align-items:center; padding:8px 14px;
           border-bottom:1px solid rgba(255,255,255,.08); font-size:12.5px; }
  .dot { width:8px;height:8px;border-radius:50%;background:#a78bfa;box-shadow:0 0 0 3px rgba(167,139,250,.2);
         animation:p 1.4s ease-in-out infinite }
  @keyframes p { 50% { opacity:.4 } }
  .url { color:#8b8797; font-family:ui-monospace,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  .wrap { position:relative; width:100%; max-width:1280px; margin:0 auto; }
  img { display:block; width:100%; height:auto; background:#111; }
  #cur, #curDot { position:absolute; top:0; left:0; pointer-events:none; }
  #curDot { width:14px;height:14px;border-radius:50%;background:rgba(167,139,250,.9);
            transform:translate(-50%,-50%); box-shadow:0 0 12px rgba(167,139,250,.9); }
  #cur { width:22px;height:22px; transform:translate(-2px,-2px); }
  .bar { display:flex; gap:8px; padding:10px 14px; border-top:1px solid rgba(255,255,255,.08); }
  .bar input { flex:1; padding:9px 11px; border-radius:10px; border:1px solid rgba(255,255,255,.12);
               background:rgba(255,255,255,.05); color:#f6f5fa; font-size:14px; }
  .bar button { padding:9px 14px; border-radius:10px; border:1px solid rgba(167,139,250,.45);
                background:rgba(167,139,250,.2); color:#f6f5fa; font-weight:550; }
  .ripple { position:absolute; border:2px solid #a78bfa; border-radius:50%;
            transform:translate(-50%,-50%); animation:r .55s ease-out forwards; pointer-events:none }
  @keyframes r { from { width:14px;height:14px;opacity:1 } to { width:70px;height:70px;opacity:0 } }
</style></head>
<body>
<header><span class="dot"></span><b>Valen · navegador en vivo</b><span class="url" id="url">conectando…</span></header>
<div class="wrap" id="wrap">
  <img id="screen" src="/stream" alt="pantalla">
  <svg id="cur" viewBox="0 0 24 24" fill="white" stroke="#0a0a0f" stroke-width="1.2">
    <path d="M4 2l14 9-6 1.4L9.6 19z"/>
  </svg>
  <div id="curDot" hidden></div>
</div>
<div class="bar">
  <input id="escribir" placeholder="Escribe aquí y pulsa Enter (va a la página)" autocomplete="off">
  <button id="enviar">Enviar</button>
</div>
<script>
  const wrap = document.getElementById('wrap'), cur = document.getElementById('cur');
  const dot = document.getElementById('curDot'), url = document.getElementById('url');
  const img = document.getElementById('screen');
  let vw = 1280;
  const scale = () => img.clientWidth / vw || 1;
  img.addEventListener('load', () => { vw = img.naturalWidth || 1280; });
  function place(c) {
    const k = scale();
    cur.style.transform = `translate(${c.x*k - 2}px, ${c.y*k - 2}px)`;
    cur.setAttribute('width', 22*k); cur.setAttribute('height', 22*k);
  }
  function ripple(c) {
    const k = scale(), d = document.createElement('div');
    d.className = 'ripple';
    d.style.left = c.x*k + 'px'; d.style.top = c.y*k + 'px';
    wrap.appendChild(d); setTimeout(() => d.remove(), 600);
  }
  let ws = null;
  (function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/ws');
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.cursor) place(m.cursor);
      if (m.click) ripple(m.click);
      if (m.url) url.textContent = m.url;
    };
    ws.onclose = () => setTimeout(connect, 1500);
  })();

  // interacción: clic en la pantalla y texto desde la caja
  img.style.cursor = 'crosshair';
  img.addEventListener('click', (e) => {
    const r = img.getBoundingClientRect();
    const x = (e.clientX - r.left) * (vw / r.width);
    const y = (e.clientY - r.top) * ((img.naturalHeight || 800) / r.height);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ click: { x: Math.round(x), y: Math.round(y) } }));
  });
  // arrastrar sobre la imagen = hacer scroll en la página remota
  let dragging = false, lastY = 0;
  img.addEventListener('pointerdown', (e) => { dragging = true; lastY = e.clientY; img.setPointerCapture(e.pointerId); });
  img.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = Math.round((lastY - e.clientY) * ((img.naturalHeight || 800) / img.getBoundingClientRect().height));
    if (Math.abs(dy) > 12) { lastY = e.clientY; if (ws && ws.readyState === 1) ws.send(JSON.stringify({ scroll: dy })); }
  });
  img.addEventListener('pointerup', () => { dragging = false; });
  img.addEventListener('pointercancel', () => { dragging = false; });

  const enviar = () => {
    const el = document.getElementById('escribir');
    const t = el.value;
    if (!t) return;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ text: t, key: 'Enter' }));
    el.value = '';
  };
  document.getElementById('enviar').addEventListener('click', enviar);
  document.getElementById('escribir').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') enviar();
  });
</script>
</body></html>
"""


async def index(request):
    return web.Response(text=VIEWER, content_type="text/html")


async def watchdog():
    """Sin espectadores ni órdenes durante 5 min: se aparca (deja de renderizar)."""
    while True:
        await asyncio.sleep(30)
        quieto = time.time() - state["last_action"]
        if not state["clients"] and quieto > 300 and not state["idle"]:
            state["idle"] = True
            try:
                await state["page"].goto("about:blank")
            except Exception:
                pass
            print("navegador aparcado (sin actividad 5 min)", flush=True)


async def on_startup(app):
    pw = await async_playwright().start()
    perfil = os.environ.get("LUMI_BROWSER_PROFILE", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".browser-profile"))
    os.makedirs(perfil, exist_ok=True)
    # perfil persistente: guarda cookies/sesión (menos captchas y no reaceptar cookies)
    # En contenedor (root) Chromium no arranca sin --no-sandbox.
    # BROWSER_LIVE_NO_SANDBOX=1 lo activa; fuera de Docker no hace falta.
    args = ["--no-sandbox", "--disable-dev-shm-usage"] if os.environ.get("BROWSER_LIVE_NO_SANDBOX") == "1" else []
    ctx = await pw.chromium.launch_persistent_context(
        perfil,
        headless=True,
        args=args,
        viewport={"width": VIEW_W, "height": VIEW_H},
        locale="es-ES",
        user_agent=(
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        ),
        extra_http_headers={"Accept-Language": "es-ES,es;q=0.9,en;q=0.8"},
        accept_downloads=True,
    )
    page = ctx.pages[0] if ctx.pages else await ctx.new_page()
    state.update({"context": ctx, "page": page, "pw": pw})
    try:
        await page.goto(START_URL, wait_until="domcontentloaded", timeout=15000)
        state["url"] = page.url
    except Exception:
        pass
    asyncio.create_task(watchdog())
    print(f"navegador vivo en http://0.0.0.0:{PORT} (perfil persistente)", flush=True)


async def on_cleanup(app):
    try:
        await state["context"].close()
        await state["pw"].stop()
    except Exception:
        pass



# ---------------------------------------------------------------------------
# Autenticación por token firmado.
# Este servicio controla un Chromium con sesiones reales (cookies, logins): si
# queda abierto, cualquiera en la LAN o en el tailnet puede navegar con ellas y
# leer el texto de las páginas. El token se deriva del mismo secreto que la web
# y caduca cada día; el dashboard lo pide en /api/browser-url.
# ---------------------------------------------------------------------------
def _secreto():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        with open(os.path.join(root, "secret.json"), encoding="utf-8") as fh:
            pwd = str(json.load(fh).get("webPassword") or "")
    except Exception:
        return None
    if not pwd:
        return None
    return hashlib.sha256((pwd + "::lumi").encode()).digest()


def token_valido(t):
    key = _secreto()
    if not key or not t:
        return False
    hoy = datetime.date.today()
    for delta in (0, -1):  # margen para el cambio de día
        dia = (hoy + datetime.timedelta(days=delta)).isoformat()
        esperado = hmac.new(key, f"browser:{dia}".encode(), hashlib.sha256).hexdigest()
        if hmac.compare_digest(str(t), esperado):
            return True
    return False


@web.middleware
async def exigir_token(request, handler):
    if not token_valido(request.query.get("token")):
        return web.Response(status=401, text="no autorizado", content_type="text/plain")
    return await handler(request)


app = web.Application(middlewares=[exigir_token])
app.router.add_get("/", index)
app.router.add_get("/stream", stream_handler)
app.router.add_get("/ws", ws_handler)
app.router.add_post("/do", do_handler)
app.on_startup.append(on_startup)
app.on_cleanup.append(on_cleanup)

async def run():
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()

    # HTTPS en PORT+1 con el certificado propio (para iframes desde https)
    https_port = int(os.environ.get("BROWSER_LIVE_HTTPS_PORT", str(PORT + 1)))
    _root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    cert, key = os.path.join(_root, "certs", "cert.pem"), os.path.join(_root, "certs", "key.pem")
    tls_cert, tls_key = os.path.join(_root, "certs-tls", "cert.pem"), os.path.join(_root, "certs-tls", "key.pem")
    if os.path.exists(tls_cert) and os.path.exists(tls_key):
        cert, key = tls_cert, tls_key
    if os.path.exists(cert) and os.path.exists(key):
        import ssl
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        await web.TCPSite(runner, "0.0.0.0", https_port, ssl_context=ctx).start()
        print(f"https en https://0.0.0.0:{https_port}", flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(run())
