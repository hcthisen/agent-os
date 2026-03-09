FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json* tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/admin/package.json apps/admin/

RUN npm install --workspace=apps/admin --workspace=packages/shared

COPY packages/shared/ packages/shared/
COPY apps/admin/ apps/admin/

RUN npm run build -w packages/shared && npm run build -w apps/admin

FROM node:20-bookworm-slim

COPY --from=build /app/apps/admin/dist /app/dist
COPY apps/admin/server.mjs /app/server.mjs

EXPOSE 80

CMD ["node", "/app/server.mjs"]
