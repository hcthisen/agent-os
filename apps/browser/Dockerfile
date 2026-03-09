FROM node:20-bookworm-slim

# Install dependencies for headless Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app

COPY apps/browser/package.json apps/browser/
RUN cd apps/browser && npm install

COPY apps/browser/ apps/browser/

RUN cd apps/browser && npm run build

EXPOSE 3002

CMD ["node", "apps/browser/dist/index.js"]
