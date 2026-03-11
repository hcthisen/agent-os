import { config } from "./config.js";
import { recoverOrphanedTasks } from "./recovery.js";
import { pollForTasks } from "./task-poller.js";
import { routeMessages } from "./message-router.js";
import { checkSchedules } from "./scheduler.js";
import { getActiveCount } from "./process-manager.js";
import { startAsyncWorkers, stopAsyncWorkers } from "./async-workers.js";
import { getRuntimeProviderStatus } from "./runtime-provider.js";
import http from "node:http";

let running = true;

async function main() {
  console.log("Agent-OS Supervisor starting...");
  console.log(`Concurrency limit: ${config.concurrencyLimit}`);

  // Recover orphaned tasks from previous run
  await recoverOrphanedTasks();

  // Start polling loops
  const taskPollLoop = setInterval(async () => {
    if (!running) return;
    try {
      await pollForTasks();
    } catch (err) {
      console.error("Task poll error:", err);
    }
  }, config.pollIntervalMs);

  const messagePollLoop = setInterval(async () => {
    if (!running) return;
    try {
      await routeMessages();
    } catch (err) {
      console.error("Message route error:", err);
    }
  }, config.pollIntervalMs);

  const schedulePollLoop = setInterval(async () => {
    if (!running) return;
    try {
      await checkSchedules();
    } catch (err) {
      console.error("Schedule check error:", err);
    }
  }, config.scheduleCheckIntervalMs);

  // Start async workers (embedding generation, memory distillation, artifact chunking)
  startAsyncWorkers();

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
