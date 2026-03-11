FROM node:20-alpine AS build

WORKDIR /app

COPY apps/browser/package.json apps/browser/package-lock.json apps/browser/tsconfig.json apps/browser/
RUN cd apps/browser && npm ci

COPY apps/browser/src/ apps/browser/src/

RUN cd apps/browser && npm run build

FROM node:20-alpine

RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

WORKDIR /app

COPY apps/browser/package.json apps/browser/package-lock.json apps/browser/
RUN cd apps/browser && npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/apps/browser/dist/ apps/browser/dist/

EXPOSE 3002

CMD ["node", "apps/browser/dist/index.js"]
