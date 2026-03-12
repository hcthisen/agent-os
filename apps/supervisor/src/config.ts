export const config = {
  concurrencyLimit: parseInt(process.env.CONCURRENCY_LIMIT || "5", 10),
  mcpConfigPath: process.env.MCP_CONFIG_PATH || "/app/apps/mcp/mcp-config.json",
  agentsInstructionsPath:
    process.env.AGENTS_INSTRUCTIONS_PATH || "/app/AGENTS_INSCTRUCTIONS.md",
  workspaceTemplateDir: process.env.WORKSPACE_TEMPLATE_DIR || "/app",
  agentHomeDir:
    process.env.AGENT_HOME_DIR || process.env.CLAUDE_HOME_DIR || "/home/node",
  agentRunAsUid: parseInt(
    process.env.AGENT_RUN_AS_UID || process.env.CLAUDE_RUN_AS_UID || "1000",
    10
  ),
  agentRunAsGid: parseInt(
    process.env.AGENT_RUN_AS_GID || process.env.CLAUDE_RUN_AS_GID || "1000",
    10
  ),
  workspacesDir: process.env.WORKSPACES_DIR || "/app/workspaces",
  publicLiveDir: process.env.PUBLIC_LIVE_DIR || "/app/public-live",
  publicSiteUrl: process.env.PUBLIC_SITE_URL || "",
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000", 10),
  scheduleCheckIntervalMs: parseInt(process.env.SCHEDULE_CHECK_MS || "30000", 10),
  taskAttentionCheckIntervalMs: parseInt(
    process.env.TASK_ATTENTION_CHECK_MS || "30000",
    10
  ),
  completionNotificationLookbackMs: parseInt(
    process.env.COMPLETION_NOTIFICATION_LOOKBACK_MS || "900000",
    10
  ),
  processActivityHeartbeatMs: parseInt(
    process.env.PROCESS_ACTIVITY_HEARTBEAT_MS || "60000",
    10
  ),
  processInactivityCheckMs: parseInt(
    process.env.PROCESS_INACTIVITY_CHECK_MS || "30000",
    10
  ),
  readyTaskAlertMs: parseInt(process.env.READY_TASK_ALERT_MS || "300000", 10),
  claimedTaskAlertMs: parseInt(process.env.CLAIMED_TASK_ALERT_MS || "300000", 10),
  runningTaskAlertMs: parseInt(process.env.RUNNING_TASK_ALERT_MS || "900000", 10),
  processInactivityTimeoutMs: parseInt(
    process.env.PROCESS_INACTIVITY_TIMEOUT_MS ||
      process.env.PROCESS_TIMEOUT_MS ||
      "1800000",
    10
  ), // 30 min inactivity timeout default
};
