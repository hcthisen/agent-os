FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/mcp/package.json apps/mcp/

RUN npm install --workspace=apps/mcp --workspace=packages/shared

COPY packages/shared/ packages/shared/
COPY apps/mcp/ apps/mcp/

RUN npm run build -w packages/shared && npm run build -w apps/mcp

CMD ["node", "apps/mcp/dist/index.js"]
