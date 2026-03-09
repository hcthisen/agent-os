# Repository Guidelines

## Project Structure & Module Organization
`agent-os` is an npm workspace monorepo. Primary code lives in `apps/` and `packages/`:

- `apps/admin`: React 19 + Vite admin UI (`src/` for app code, `dist/` for builds).
- `apps/supervisor`: Node/TypeScript task runner and scheduler.
- `apps/mcp`: MCP server implementation.
- `apps/browser`: browser automation service.
- `packages/shared`: shared types, schemas, and helpers used across apps.
- `sites/public`: public-facing site assets.
- `scripts/`: operational shell scripts such as `test-mcp-tools.sh`.
- `supabase/`: database-related project files.

## Build, Test, and Development Commands
- `npm install`: install workspace dependencies from the repo root.
- `npm run build`: build shared code, then all apps in dependency order.
- `npm run dev:admin`: start the Vite admin app locally.
- `npm run dev:supervisor`: watch and rebuild the supervisor service.
- `npm run dev:mcp`: watch and rebuild the MCP server.
- `npm run build:admin` / `build:supervisor` / `build:mcp` / `build:browser`: build a single workspace.
- `bash scripts/test-mcp-tools.sh`: optional MCP smoke test when the local stack is available.

## Coding Style & Naming Conventions
Use TypeScript with ESM imports, 2-space indentation, double quotes, and semicolons. Follow the existing naming pattern:

- React components: `PascalCase` files and exports, for example `Dashboard.tsx`.
- Backend modules: descriptive `kebab-case`, for example `task-poller.ts`.
- Shared constants and config: keep names explicit and colocated with their package.

Prefer small modules, typed interfaces, and imports from `packages/shared` over duplicate definitions.

## Testing Guidelines
There is no top-level automated test runner yet. For changes, add focused tests as `*.test.ts` or `*.test.tsx` next to the affected code when practical. Minimum verification is:

- run the relevant workspace build;
- run `npm run build` for cross-workspace changes;
- include screenshots for UI changes in `apps/admin` or `sites/public`.

## Commit & Pull Request Guidelines
Git history uses short, imperative subjects such as `Initial monorepo scaffold and services`. Keep commits concise and scoped, for example `Add MCP task retry guard`.

PRs should include a brief summary, impacted workspaces, setup or env changes, and verification steps. Link the related issue when available, and attach screenshots for visible UI changes.

## Security & Configuration Tips
Do not commit `.env` files, service tokens, or Supabase credentials. Start from `.env.example`, document any new variables there, and keep deployment-specific values in the hosting platform rather than hardcoding them in source.
