# Agent-OS

A self-hosted AI employee system that runs on a single VPS. AI agents claim tasks from a queue, execute work, write handoff notes, and pass work to each other — autonomously.

## Install

SSH into a fresh Ubuntu/Debian VPS and run:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/hcthisen/agent-os/main/scripts/bootstrap.sh)"
```

Or fully automated (no prompts):

```bash
AGENT_OS_ADD_DOMAIN=yes \
AGENT_OS_DOMAIN=example.com \
AGENT_OS_ADMIN_USER=admin \
AGENT_OS_ADMIN_PASS=supersecretpassword \
TELEGRAM_BOT_TOKEN=123456:ABC-DEF... \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/hcthisen/agent-os/main/scripts/bootstrap.sh)"
```

The installer handles everything: Docker, the repo, secrets, systemd, first boot, and optionally domain/TLS setup.

If you answer `no` to domain setup, the installer skips Caddy and keeps the admin app on port `3000`:

- on the same machine: `http://localhost:3000`
- on a VPS: `http://<server-ip>:3000`

### DNS

Before installing, point your domain at the VPS if you want HTTPS/domain routing:

| Record | Type | Value |
|--------|------|-------|
| `example.com` | A | `<VPS IP>` |
| `*.example.com` | A | `<VPS IP>` |

Caddy auto-provisions HTTPS via Let's Encrypt when domain setup is enabled.

### What the installer does

1. Installs Docker + Compose (if missing)
2. Clones the repo to `/opt/agent-os`
3. Collects config (domain yes/no, admin credentials) or reads env vars
4. Generates all secrets (Postgres password, JWT, Supabase keys)
5. Creates a systemd service for auto-start on reboot
6. Builds and starts the full stack via `docker compose`

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  VPS (Docker Compose + Caddy)                                   │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ admin.domain │  │  domain.com  │  │  Supabase             │  │
│  │  Admin App   │  │ Public Site  │  │  Postgres + Auth +    │  │
│  │              │  │              │  │  Storage + Realtime   │  │
│  └──────┬───────┘  └──────▲───────┘  └──────────┬────────────┘  │
│         │                 │                      │               │
│  ┌──────▼─────────────────┴──────────┐  ┌───────▼────────────┐  │
│  │  Supervisor                       │  │  MCP Server        │  │
│  │  Process manager for AI agents    │  │  Policy + DB gate  │  │
│  └──────────┬────────────────────────┘  └───────┬────────────┘  │
│             │                                    │               │
│  ┌──────────▼────────────┐  ┌────────────────────▼───────────┐  │
│  │  Agent CLI Processes  │  │  Browser Service               │  │
│  │  claude or codex      │  │  Headless Chromium             │  │
│  │  up to N parallel     │  │  auth, research, QA            │  │
│  └───────────────────────┘  └────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Services

| Service | Exposure | Purpose |
|---------|----------|---------|
| **Supabase** (Postgres, Auth, Storage, Realtime) | Internal | All durable state |
| **Supervisor** | Internal | Claims tasks, builds context packs, launches agent CLI processes |
| **MCP Server** | Internal | Tool interface between agents and DB. Enforces scope and policy |
| **Admin App** | `admin.domain.com` or `localhost:3000` / `IP:3000` | Chat, task dashboard, agent config, provider controls |
| **Public Site** | `domain.com` | Optional public surface, managed by agents |
| **Browser** | Internal | Headless Chromium for auth flows, research, QA |
| **Caddy** | `80/443` | Reverse proxy, auto TLS |
| **Telegram Bot** | Webhook | Optional, same message queue as admin chat |

### Runtime Providers

The supervisor launches AI agents as native CLI processes. Two providers are supported:

- **Claude Code** (`claude`) — using your Claude subscription
- **OpenAI Codex** (`codex`) — using your ChatGPT/Codex subscription

No API keys required for the core agent loop. The system uses the provider's own CLI auth (`~/.claude` or `~/.codex`), never extracts session tokens.

### The Six Agents

| Role | Profile | Purpose |
|------|---------|---------|
| **Relay** | Fast | Classifies messages, routes work |
| **Sage** | Frontier | Strategic planning, decomposition |
| **Builder** | Frontier | Writes code, content, integrations |
| **Reviewer** | Frontier | Quality gate for completed work |
| **Architect** | Frontier | Governs system changes and evolution |
| **Sentinel** | Balanced | Watchdog for queue, auth, cost, health |

New agents are created as data (rows in `roles` + `agents`), not new binaries or containers.

### Task State Machine

```
backlog → ready → claimed → running → in_review → completed
                                   ↘ blocked_on_agent
                                   ↘ failed → dead_letter
```

Every transition out of `running` requires a structured handoff note. Invalid transitions are rejected at the Postgres level.

## Post-Install

### First Login

1. Open `https://admin.your-domain.com` when domain setup is enabled, otherwise open `http://localhost:3000` or `http://<server-ip>:3000`
2. Sign in with the credentials from setup
3. Connect your coding provider (Claude or Codex) via the admin panel
4. Send your first message — the relay picks it up and the work loop begins

### Day-2 Operations

```bash
cd /opt/agent-os

# Stack status
bash scripts/manage-vps-stack.sh status

# Follow logs
bash scripts/manage-vps-stack.sh logs
bash scripts/manage-vps-stack.sh logs supervisor

# Rebuild and restart
bash scripts/manage-vps-stack.sh reload

# Restart specific service
bash scripts/manage-vps-stack.sh restart supervisor

# Reload Caddy after adding site snippets
bash scripts/manage-vps-stack.sh caddy-reload
```

### Update

```bash
cd /opt/agent-os && git pull && bash scripts/manage-vps-stack.sh reload
```

Or re-run the bootstrap (it pulls latest if the repo already exists):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/hcthisen/agent-os/main/scripts/bootstrap.sh)"
```

## Repo Structure

```
apps/supervisor/    Supervisor daemon (Node.js)
apps/mcp/           MCP server
apps/admin/         Admin panel (React SPA)
apps/browser/       Headless browser service
sites/public/       Public site (Nginx)
supabase/           Self-hosted Supabase + migrations
packages/shared/    Shared TypeScript library
scripts/            Install, bootstrap, and management scripts
docker/             Dockerfiles and Caddy config
```

## Configuration

### Environment Variables (bootstrap)

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENT_OS_ADD_DOMAIN` | No | `yes` to enable Caddy/domain setup, `no` to run on port `3000` only |
| `AGENT_OS_DOMAIN` | Yes** | Root domain pointed at the VPS |
| `AGENT_OS_ADMIN_USER` | Yes* | Admin panel username |
| `AGENT_OS_ADMIN_PASS` | Yes* | Admin panel password |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token |
| `AGENT_OS_DIR` | No | Install directory (default: `/opt/agent-os`) |
| `AGENT_OS_BRANCH` | No | Git branch to deploy (default: `main`) |

\* Prompted interactively if not set.

\** Required only when `AGENT_OS_ADD_DOMAIN=yes`.

### Auto-Generated Secrets

On first boot, the `init` service generates and stores in a persistent Docker volume:

- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `SERVICE_REGISTRY_ENCRYPTION_KEY`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_KEY`

You never need to manage these manually.

## Requirements

- Ubuntu or Debian VPS
- Optional domain with A + wildcard A records pointed at the VPS
- Docker is installed automatically if missing

## Documentation

| File | Contents |
|------|----------|
| `ARCHITECTURE.md` | Full system architecture, security model, deployment details |
| `SCHEMA.md` | Database schema, table definitions, RLS policies, hybrid search |
| `DECISIONS.md` | Architectural decisions with rationale |
| `AGENTS.md` | Repository guidelines for agents and contributors |

## License

Private.
