# Prompt Assembly Refactor Plan

## Goal

Replace the current runtime prompt assembly that depends on the repo-root `AGENTS.md`
with a database-driven role policy system. Keep `AGENTS_INSCTRUCTIONS.md` as the single
foundational system file, move role-specific behavior into Supabase, and generate
runtime docs per task so future specialized roles and agents can be created without
adding repo files.

## Constraints

- `AGENTS_INSCTRUCTIONS.md` remains the foundational file in the repo.
- Role-specific instructions must live in Supabase, not as repo files.
- New roles must become visible to other agents automatically at spawn time.
- The runtime prompt should become less redundant and less confusing.
- The six foundational roles remain undeletable system roles.

## Implementation Steps

### 1. Extend the role schema and seed foundational role policies

Add the database fields needed to make roles self-describing:

- `roles.usage_summary`
- `roles.handoff_when`

Seed the six foundational roles with:

- concise `usage_summary`
- explicit `handoff_when`
- full `policy_doc` content migrated out of the role-specific sections currently living
  inside `AGENTS_INSCTRUCTIONS.md`

Success criteria:

- foundational roles have enough DB-resident policy to run without reading role-specific
  guidance from the repo
- future roles can be created entirely from Supabase data

### 2. Refactor `build_context_pack()` to expose runtime role context

Update the context pack to include:

- `role` object
- `agent_identity`
- `available_roles` directory entries for all active roles

Keep compatibility where useful, but move the runtime toward DB-native role context.

Success criteria:

- every task context contains the current role policy and a compact directory of other
  available roles
- other agents can discover newly created specialized roles automatically

### 3. Change supervisor prompt assembly and workspace docs

Stop copying repo-root `AGENTS.md` into task workspaces.

Generate per-task runtime docs instead:

- `AGENTS_INSCTRUCTIONS.md` from the repo
- `ROLE_POLICY.md` from Supabase
- `ROLE_DIRECTORY.md` from Supabase
- `AGENT_IDENTITY.md` from the current agent row
- `TASK_BRIEFING.md` with task/project/history context only

Update the launch prompt so agents read those runtime docs instead of `AGENTS.md`.

Success criteria:

- no runtime dependency on repo-root `AGENTS.md`
- each agent gets only foundational rules + its own role policy + role directory +
  identity + task briefing

### 4. Trim `AGENTS_INSCTRUCTIONS.md` to foundational rules only

Remove the long role-specific sections and replace them with:

- shared system rules
- how the six foundational roles cooperate
- how evolved roles fit into the system
- runtime document expectations

Success criteria:

- role-specific behavior is no longer duplicated in the repo file
- foundational collaboration remains documented in one stable place

### 5. Add system tools for dynamic role/agent creation

Introduce MCP tools so architect-approved system modifications can create and update:

- roles
- agents

These tools should be protected as `system.modify`.

Success criteria:

- the architect has a generic path to create new specialized roles/agents after deployment
- new roles appear automatically in the role directory on future spawns

### 6. Update types and documentation

Update shared TypeScript types and schema documentation so the new prompt assembly model
is explicit and maintainable.

Success criteria:

- shared types compile cleanly
- schema docs match the new runtime design

### 7. Verification

Run builds for the affected workspaces and verify the refactor is internally consistent.

Minimum verification:

- `npm run build -w packages/shared`
- `npm run build -w apps/mcp`
- `npm run build -w apps/supervisor`

Stretch verification:

- `npm run build`

## Status

- [x] Step 1 complete
- [x] Step 2 complete
- [x] Step 3 complete
- [x] Step 4 complete
- [x] Step 5 complete
- [x] Step 6 complete
- [x] Step 7 complete
