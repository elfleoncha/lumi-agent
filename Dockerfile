# Lumi en un contenedor.
#
#   docker build -t lumi .
#   docker run --rm -p 4477:4477 -p 4478:4478 \
#     -v "$PWD/config.json:/app/config.json" \
#     -v "$PWD/secret.json:/app/secret.json" \
#     -v "$HOME/.pi:/root/.pi" \
#     -v lumi-data:/app/sessions lumi
#
# La clave del modelo va por variable de entorno (DEEPSEEK_API_KEY, OPENAI_API_KEY,
# GROQ_API_KEY...). Montar ~/.pi también vale, pero en un contenedor limpio lo
# fiable es la variable.
FROM node:22-slim

# ffmpeg y python: voz (Cast/TTS) y transcripción de notas de voz.
# Si no los quieres, comenta este bloque y quita el venv; el resto funciona.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-venv python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY requirements.txt ./
RUN python3 -m venv .venv \
 && ./.venv/bin/pip install --no-cache-dir --quiet --upgrade pip \
 && ./.venv/bin/pip install --no-cache-dir --quiet -r requirements.txt

COPY src ./src
COPY public ./public
COPY bin ./bin
COPY scripts ./scripts

RUN mkdir -p sessions uploads public/files media/in media/out

ENV NODE_ENV=production
EXPOSE 4477 4478

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4477/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
