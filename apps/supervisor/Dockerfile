FROM node:20-bookworm-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates chromium docker.io && \
    rm -rf /var/lib/apt/lists/*

# Install both supported coding CLIs.
RUN npm install -g @anthropic-ai/claude-code @openai/codex agent-browser

# Pre-configure the shared agent home for both providers.
RUN mkdir -p /home/node/.claude /home/node/.codex && \
    echo '{"skipDangerousModePermissionPrompt": true}' > /home/node/.claude/settings.json && \
    chown -R 1000:1000 /home/node/.claude /home/node/.codex

WORKDIR /app

# Copy workspace root for npm workspaces
COPY package.json package-lock.json* tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/supervisor/package.json apps/supervisor/
COPY apps/mcp/package.json apps/mcp/

RUN npm install --workspace=apps/supervisor --workspace=apps/mcp --workspace=packages/shared

COPY packages/shared/ packages/shared/
COPY apps/mcp/ apps/mcp/
COPY apps/supervisor/ apps/supervisor/

RUN npm run build -w packages/shared && npm run build -w apps/mcp && npm run build -w apps/supervisor

COPY apps/ apps/
COPY docker/ docker/
COPY packages/ packages/
COPY scripts/ scripts/
COPY sites/ sites/
COPY supabase/ supabase/
COPY .dockerignore .env.example .gitattributes .gitignore AGENTS.md ARCHITECTURE.md CLAUDE.md DECISIONS.md PLAN.md SCHEMA.md docker-compose.vps.yaml docker-compose.yaml ./

COPY --chmod=755 scripts/entrypoint.sh /scripts/entrypoint.sh

# Copy durable foundational agent instructions
COPY AGENTS_INSCTRUCTIONS.md /app/AGENTS_INSCTRUCTIONS.md

ENV AGENT_HOME_DIR=/home/node
ENV AGENT_RUN_AS_UID=1000
ENV AGENT_RUN_AS_GID=1000
ENV CHROMIUM_PATH=/usr/bin/chromium

EXPOSE 3001

CMD ["node", "apps/supervisor/dist/index.js"]
