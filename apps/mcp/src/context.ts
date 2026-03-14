/**
 * Agent identity context for the current MCP session.
 * Set by the supervisor when launching the MCP server for a specific agent run.
 */
export interface AgentContext {
  agent_id: string;
  role_id: string;
  run_id: string;
  task_id: string | null;
  trace_id: string;
}

let currentContext: AgentContext | null = null;

export function setAgentContext(ctx: AgentContext): void {
  currentContext = ctx;
}

export function getAgentContext(): AgentContext {
  if (!currentContext) {
    throw new Error("Agent context not initialized");
  }
  return currentContext;
}
