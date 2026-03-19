import { config } from "./config.js";
import { recoverOrphanedTasks } from "./recovery.js";
import { pollForTasks } from "./task-poller.js";
import { routeMessages } from "./message-router.js";
import { checkSchedules, reconcileLegacySchedules } from "./scheduler.js";
import { cleanupWorkspaces, getActiveCount } from "./process-manager.js";
import { startAsyncWorkers, stopAsyncWorkers } from "./async-workers.js";
import { getRuntimeProviderStatus } from "./runtime-provider.js";
import { monitorTaskAttention } from "./task-attention.js";
import { monitorTaskOutcomes } from "./task-outcomes.js";
import { sendManagedMessage } from "./operator-delivery.js";
import {
  handlePublicSiteRouteControl,
  handleServiceRequestControl,
  handleServiceControlControl,
} from "./control-plane.js";
import {
  cancelAnthropicSubscriptionAuth,
  cancelOpenAiDeviceAuth,
  getAnthropicSubscriptionAuthState,
  getOpenAiDeviceAuthState,
  startAnthropicSubscriptionAuth,
  startOpenAiDeviceAuth,
  submitAnthropicSubscriptionAuthCode,
} from "./provider-auth.js";
import { createRuntimeEmbedding } from "./service-registry.js";
import http from "node:http";

let running = true;
let taskPollInFlight = false;
let messageRouteInFlight = false;
let schedulePollInFlight = false;
let attentionPollInFlight = false;
let workspaceCleanupInFlight = false;

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function main() {
  console.log("Agent-OS Supervisor starting...");
  console.log(`Concurrency limit: ${config.concurrencyLimit}`);

  // Recover orphaned tasks from previous run
  await recoverOrphanedTasks();
  await reconcileLegacySchedules();

  // Start polling loops
  const taskPollLoop = setInterval(async () => {
    if (!running || taskPollInFlight) return;
    taskPollInFlight = true;
    try {
      await pollForTasks();
    } catch (err) {
      console.error("Task poll error:", err);
    } finally {
      taskPollInFlight = false;
    }
  }, config.pollIntervalMs);

  const messagePollLoop = setInterval(async () => {
    if (!running || messageRouteInFlight) return;
    messageRouteInFlight = true;
    try {
      await routeMessages();
    } catch (err) {
      console.error("Message route error:", err);
    } finally {
      messageRouteInFlight = false;
    }
  }, config.pollIntervalMs);

  const schedulePollLoop = setInterval(async () => {
    if (!running || schedulePollInFlight) return;
    schedulePollInFlight = true;
    try {
      await checkSchedules();
    } catch (err) {
      console.error("Schedule check error:", err);
    } finally {
      schedulePollInFlight = false;
    }
  }, config.scheduleCheckIntervalMs);

  const attentionPollLoop = setInterval(async () => {
    if (!running || attentionPollInFlight) return;
    attentionPollInFlight = true;
    try {
      await monitorTaskAttention();
      await monitorTaskOutcomes();
    } catch (err) {
      console.error("Task attention/outcome monitor error:", err);
    } finally {
      attentionPollInFlight = false;
    }
  }, config.taskAttentionCheckIntervalMs);

  const workspaceCleanupLoop = setInterval(async () => {
    if (!running || workspaceCleanupInFlight) return;
    workspaceCleanupInFlight = true;
    try {
      await cleanupWorkspaces();
    } catch (err) {
      console.error("Workspace cleanup error:", err);
    } finally {
      workspaceCleanupInFlight = false;
    }
  }, 60 * 60 * 1000);

  // Start async workers (embedding generation, memory distillation, artifact chunking)
  startAsyncWorkers();
  await cleanupWorkspaces();

  try {
    attentionPollInFlight = true;
    await monitorTaskAttention();
    await monitorTaskOutcomes();
  } catch (err) {
    console.error("Initial task attention/outcome monitor error:", err);
  } finally {
    attentionPollInFlight = false;
  }

  // Health endpoint for Docker healthchecks
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      const runtimeProvider = await getRuntimeProviderStatus(config.agentHomeDir);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          active_processes: getActiveCount(),
          concurrency_limit: config.concurrencyLimit,
          runtime_provider: runtimeProvider,
        })
      );
    } else if (
      req.url === "/provider-auth/anthropic/oauth" &&
      req.method === "GET"
    ) {
      const state = await getAnthropicSubscriptionAuthState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
    } else if (
      req.url === "/provider-auth/anthropic/oauth/start" &&
      req.method === "POST"
    ) {
      const state = await startAnthropicSubscriptionAuth();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
    } else if (
      req.url === "/provider-auth/anthropic/oauth/cancel" &&
      req.method === "POST"
    ) {
      const state = await cancelAnthropicSubscriptionAuth();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
    } else if (
      req.url === "/provider-auth/anthropic/oauth/submit" &&
      req.method === "POST"
    ) {
      try {
        const payload = await readJsonBody(req);
        const state = await submitAnthropicSubscriptionAuthCode(
          String(payload.code || payload.value || "")
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(state));
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
    } else if (
      req.url === "/provider-auth/openai/device-auth" &&
      req.method === "GET"
    ) {
      const state = await getOpenAiDeviceAuthState();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
    } else if (
      req.url === "/provider-auth/openai/device-auth/start" &&
      req.method === "POST"
    ) {
      const state = await startOpenAiDeviceAuth();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
    } else if (
      req.url === "/provider-auth/openai/device-auth/cancel" &&
      req.method === "POST"
    ) {
      const state = await cancelOpenAiDeviceAuth();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state));
    } else if (req.url === "/control/public-site-route" && req.method === "POST") {
      try {
        const payload = await readJsonBody(req);
        const result = await handlePublicSiteRouteControl(payload);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
    } else if (req.url === "/control/service-control" && req.method === "POST") {
      try {
        const payload = await readJsonBody(req);
        const result = await handleServiceControlControl(payload);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
    } else if (req.url === "/control/service-request" && req.method === "POST") {
      try {
        const payload = await readJsonBody(req);
        const result = await handleServiceRequestControl(payload);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
    } else if (req.url === "/control/message-send" && req.method === "POST") {
      try {
        const payload = await readJsonBody(req);
        const result = await sendManagedMessage({
          channel:
            payload.channel === "telegram" ? "telegram" : "admin_chat",
          content: String(payload.content || ""),
          metadata:
            payload.metadata && typeof payload.metadata === "object"
              ? (payload.metadata as Record<string, unknown>)
              : undefined,
          sender:
            typeof payload.sender === "string" && payload.sender.trim()
              ? payload.sender.trim()
              : undefined,
          taskId:
            typeof payload.task_id === "string" && payload.task_id.trim()
              ? payload.task_id.trim()
              : null,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
    } else if (req.url === "/control/runtime-embedding" && req.method === "POST") {
      try {
        const payload = await readJsonBody(req);
        const embedding = await createRuntimeEmbedding({
          input: String(payload.input || ""),
          model:
            typeof payload.model === "string" && payload.model.trim()
              ? payload.model.trim()
              : undefined,
          serviceName:
            typeof payload.service_name === "string" && payload.service_name.trim()
              ? payload.service_name.trim()
              : undefined,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            service_name:
              typeof payload.service_name === "string" && payload.service_name.trim()
                ? payload.service_name.trim()
                : "openai",
            model:
              typeof payload.model === "string" && payload.model.trim()
                ? payload.model.trim()
                : "text-embedding-ada-002",
            embedding,
          })
        );
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(3001, () => {
    console.log("Health endpoint: http://0.0.0.0:3001/health");
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down supervisor...");
    running = false;
    clearInterval(taskPollLoop);
    clearInterval(messagePollLoop);
    clearInterval(schedulePollLoop);
    clearInterval(attentionPollLoop);
    clearInterval(workspaceCleanupLoop);
    stopAsyncWorkers();
    server.close();

    // Wait for active processes (with timeout)
    const deadline = Date.now() + 30000;
    while (getActiveCount() > 0 && Date.now() < deadline) {
      console.log(`Waiting for ${getActiveCount()} active process(es)...`);
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (getActiveCount() > 0) {
      console.warn(`Force-exiting with ${getActiveCount()} active processes`);
    }

    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log("Supervisor is running. Polling for tasks...");
}

main().catch((err) => {
  console.error("Supervisor fatal error:", err);
  process.exit(1);
});
