# Cambios

## 0.1.0 — 2026-10-23

Primera versión pública.

- Bot de Discord con sesiones persistentes, imágenes, notas de voz (faster-whisper)
  y audios salientes (`/tts`).
- Panel web con streaming SSE, historial, comandos, adjuntos, dictado y botón de
  cancelar que aborta de verdad.
- Sesión compartida entre Discord y web (un solo dueño del JSONL).
- Terminal propia `lumi`, sin dependencias.
- Voz por Chromecast/Nest, navegador en vivo con token, push con ntfy.
- HTTPS con certificado propio o de Tailscale; rotación automática de sesiones.
- Asistente de primer arranque, Docker y CI con pruebas de humo.
- App Android opcional con URL configurable.
