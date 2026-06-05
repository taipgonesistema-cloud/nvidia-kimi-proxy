FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=4874 \
    HEADLESS=true \
    PLAYWRIGHT_CHROME=/usr/bin/chromium \
    PLAYWRIGHT_USER_DATA_DIR=/app/profile \
    PLAYWRIGHT_CHROMIUM_ARGS="--no-sandbox --disable-dev-shm-usage --single-process" \
    PLAYWRIGHT_BROWSER_IDLE_TIMEOUT_MS=60000

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      chromium \
      curl \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY playwright-proxy.mjs ./
RUN mkdir -p /app/profile && chown -R node:node /app
USER node

EXPOSE 4874
VOLUME ["/app/profile"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/healthz >/dev/null || exit 1

CMD ["node", "playwright-proxy.mjs"]
