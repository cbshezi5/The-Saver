# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=10000 \
    MEDIA_ACCESS_MODE=official \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    YTDLP_PYTHON=/opt/yt-dlp/bin/python

# The server uses Node built-ins only. Expo/node_modules are not required.
# Keep yt-dlp available for explicitly enabled legacy public downloads.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

COPY server/requirements.txt /tmp/media-requirements.txt
RUN python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/python -m pip install --no-cache-dir -r /tmp/media-requirements.txt \
    && rm /tmp/media-requirements.txt

WORKDIR /app
COPY --chown=node:node server/*.mjs ./server/
COPY --chown=node:node shared/*.mjs ./shared/
RUN mkdir -p /app/server/cache \
    && chown node:node /app/server/cache

USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health', {signal: AbortSignal.timeout(4000)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/index.mjs"]
