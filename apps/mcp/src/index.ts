import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { setAgentContext } from "./context.js";
import { checkPolicy } from "./policy.js";
import { getCurrentTaskContext } from "./scope.js";

import { taskClaimDef, taskClaim } from "./tools/task_claim.js";
import { taskUpdateDef, taskUpdate } from "./tools/task_update.js";
import { taskCreateDef, taskCreate } from "./tools/task_create.js";
import { memorySearchDef, memorySearch } from "./tools/memory_search.js";
import { memoryWriteDef, memoryWrite } from "./tools/memory_write.js";
import { eventLogDef, eventLog } from "./tools/event_log.js";
import { artifactPutDef, artifactPut } from "./tools/artifact_put.js";
import { handoffCreateDef, handoffCreate } from "./tools/handoff_create.js";
import {
  publicSitePublishDef,
  publicSitePublish,
} from "./tools/public_site_publish.js";
import {
  approvalRequestDef,
  approvalRequest,
} from "./tools/approval_request.js";
import {
  serviceControlDef,
  serviceControl,
} from "./tools/service_control.js";
import {
  contextRefreshDef,
  contextRefresh,
} from "./tools/context_refresh.js";
import { messageSendDef, messageSend } from "./tools/message_send.js";
import {
  scheduleUpdateDef,
  scheduleUpdate,
} from "./tools/schedule_update.js";
import {
  scheduleCreateDef,
  scheduleCreate,
} from "./tools/schedule_create.js";
import { roleUpsertDef, roleUpsert } from "./tools/role_upsert.js";
import { agentUpsertDef, agentUpsert } from "./tools/agent_upsert.js";

const tools = [
  taskClaimDef,
  taskUpdateDef,
  taskCreateDef,
  memorySearchDef,
  memoryWriteDef,
  eventLogDef,
  artifactPutDef,
  handoffCreateDef,
  publicSitePublishDef,
  approvalRequestDef,
  serviceControlDef,
  contextRefreshDef,
  messageSendDef,
  scheduleUpdateDef,
  scheduleCreateDef,
  roleUpsertDef,
  agentUpsertDef,
];

const handlers: Record<string, (args: any) => Promise<unknown>> = {
  task_claim: taskClaim,
  task_update: taskUpdate,
  task_create: taskCreate,
  memory_search: memorySearch,
  memory_write: memoryWrite,
  event_log: eventLog,
  artifact_put: artifactPut,
  handoff_create: handoffCreate,
  public_site_publish: publicSitePublish,
  approval_request: approvalRequest,
  service_control: serviceControl,
  context_refresh: contextRefresh,
  message_send: messageSend,
  schedule_update: scheduleUpdate,
  schedule_create: scheduleCreate,
  role_upsert: roleUpsert,
  agent_upsert: agentUpsert,
};

async function extractPolicyAction(
  name: string,
  args: any
): Promise<{ type: string; taskId: string; desc: string } | null> {
  if (name === "approval_request") {
    return null;
  }

  if (name === "task_create") {
    const taskId = args.parent_task_id || (await getCurrentTaskContext())?.id;
    if (!taskId) {
      return null;
    }

    return {
      type: args.is_system_modification ? "system.modify" : "task.create",
      taskId,
      desc: args.is_system_modification
        ? `Create system-modification task: ${args.title || "untitled"}`
        : `Create task: ${args.title || "untitled"}`,
    };
  }

  if (name === "artifact_put") {
    const taskId = args.task_id || (await getCurrentTaskContext())?.id;
    if (!taskId) {
      return null;
    }

    return {
      type: "artifact.create",
      taskId,
      desc: `Upload artifact: ${args.name || "unnamed artifact"}`,
    };
  }

  if (name === "schedule_update") {
    const taskId = (await getCurrentTaskContext())?.id;
    if (!taskId) {
      return null;
    }

    const target =
      (typeof args?.name === "string" && args.name.trim()) ||
      (typeof args?.schedule_id === "string" && args.schedule_id.trim()) ||
      "unknown schedule";

    return {
      type: "system.modify",
      taskId,
      desc: `Update schedule: ${target}`,
    };
  }

  if (name === "schedule_create") {
    const taskId = (await getCurrentTaskContext())?.id;
    if (!taskId) {
      return null;
    }

    const target =
      (typeof args?.name === "string" && args.name.trim()) || "new schedule";

    return {
      type: "system.modify",
      taskId,
      desc: `Create schedule: ${target}`,
    };
  }

  if (name === "role_upsert") {
    const taskId = (await getCurrentTaskContext())?.id;
    if (!taskId) {
      return null;
    }

    return {
      type: "system.modify",
      taskId,
      desc: `Upsert role: ${String(args?.id || "unknown role")}`,
    };
  }

  if (name === "agent_upsert") {
    const taskId = (await getCurrentTaskContext())?.id;
    if (!taskId) {
      return null;
    }

    return {
      type: "system.modify",
      taskId,
      desc: `Upsert agent: ${String(args?.name || args?.id || "unknown agent")}`,
    };
  }

  if (name === "service_control") {
    if (args?.action === "status") {
      return null;
    }

    const taskId = (await getCurrentTaskContext())?.id;
    if (!taskId) {
      return null;
    }

    const services = [
      ...(typeof args?.service === "string" ? [args.service] : []),
      ...(Array.isArray(args?.services) ? args.services : []),
    ]
      .map((value) => String(value).trim())
      .filter(Boolean);

    return {
      type: "service.manage",
      taskId,
      desc: `${String(args?.action || "control")} service${services.length > 1 ? "s" : ""}: ${services.join(", ") || "unspecified"}`,
    };
  }

  return null;
}

async function main() {
  const agentId = process.env.AGENT_ID;
  const roleId = process.env.ROLE_ID;
  const runId = process.env.RUN_ID;
  const traceId = process.env.TRACE_ID || runId || "unknown";

  if (agentId && roleId && runId) {
    setAgentContext({
      agent_id: agentId,
      role_id: roleId,
      run_id: runId,
      trace_id: traceId,
    });
  }

  const server = new Server(
    { name: "agent-os-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = handlers[name];

    if (!handler) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) },
        ],
      };
    }

    try {
      const policyArgs = await extractPolicyAction(name, args || {});
      if (policyArgs) {
        const policyResult = await checkPolicy(
          policyArgs.type,
          policyArgs.taskId,
          policyArgs.desc
        );

        if (!policyResult.proceed) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: false,
                    blocked_by_policy: true,
                    approval_id: policyResult.approval_id,
                    reason: policyResult.reason,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      }

      const result = await handler(args || {});
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: err.message }),
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("MCP server fatal error:", err);
  process.exit(1);
});
