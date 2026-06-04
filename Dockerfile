FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y \
    chromium \
    libnss3 \
    libnspr4 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV HEADLESS=true
ENV PORT=3000
ENV NVIDIA_THINKING=false
ENV NVIDIA_MAX_TOKENS=131072
ENV NVIDIA_REQUEST_TIMEOUT_MS=120000
ENV PLAYWRIGHT_CHROME=/usr/bin/chromium
ENV PLAYWRIGHT_USER_DATA_DIR=/app/profile

EXPOSE 3000

CMD ["node", "playwright-proxy.mjs"]
