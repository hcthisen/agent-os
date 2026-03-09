FROM node:20-bookworm-slim

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Pre-configure Claude Code for headless operation
RUN mkdir -p /home/node/.claude && \
    echo '{"skipDangerousModePermissionPrompt": true}' > /home/node/.claude/settings.json && \
    chown -R 1000:1000 /home/node/.claude

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

# Copy runtime bootstrap and durable agent instructions
COPY AGENTS.md /app/AGENTS.md
COPY AGENTS_INSCTRUCTIONS.md /app/AGENTS_INSCTRUCTIONS.md

ENV CLAUDE_HOME_DIR=/home/node
ENV CLAUDE_RUN_AS_UID=1000
ENV CLAUDE_RUN_AS_GID=1000

EXPOSE 3001

CMD ["node", "apps/supervisor/dist/index.js"]
