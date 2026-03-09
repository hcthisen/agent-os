export const config = {
  concurrencyLimit: parseInt(process.env.CONCURRENCY_LIMIT || "5", 10),
  mcpConfigPath: process.env.MCP_CONFIG_PATH || "/app/apps/mcp/mcp-config.json",
  agentsMdPath: process.env.AGENTS_MD_PATH || "/app/AGENTS.md",
  agentsInstructionsPath:
    process.env.AGENTS_INSTRUCTIONS_PATH || "/app/AGENTS_INSCTRUCTIONS.md",
  claudeHomeDir: process.env.CLAUDE_HOME_DIR || "/home/node",
  claudeRunAsUid: parseInt(process.env.CLAUDE_RUN_AS_UID || "1000", 10),
  claudeRunAsGid: parseInt(process.env.CLAUDE_RUN_AS_GID || "1000", 10),
  workspacesDir: process.env.WORKSPACES_DIR || "/app/workspaces",
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000", 10),
  scheduleCheckIntervalMs: parseInt(process.env.SCHEDULE_CHECK_MS || "30000", 10),
  processTimeoutMs: parseInt(process.env.PROCESS_TIMEOUT_MS || "600000", 10), // 10 min default
};
