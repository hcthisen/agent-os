import { getAgentContext } from "../context.js";
import { getDb } from "../db.js";
import { requireCurrentTaskContext } from "../scope.js";
import { upsertTaskRequirement } from "../task_requirements.js";

type Expectation = "ok" | "unavailable";

export const publicSiteVerifyDef = {
  name: "public_site_verify",
  description:
    "Fetch a public URL and record task-level verification evidence. Use it before completing public-facing work.",
  inputSchema: {
    type: "object" as const,
    properties: {
      url: { type: "string" },
      expect: {
        type: "string",
        enum: ["ok", "unavailable"],
        default: "ok",
      },
      required_for_completion: {
        type: "boolean",
        default: true,
      },
    },
    required: ["url"],
  },
};

export async function publicSiteVerify(args: {
  url?: string;
  expect?: string;
  required_for_completion?: boolean;
}): Promise<unknown> {
  const task = await requireCurrentTaskContext();
  const url = normalizeUrl(args.url);
  const expected = normalizeExpectation(args.expect);
  const verification = await verifyPublicUrl(url, expected);

  const requirement = await upsertTaskRequirement({
    expected: {
      state: expected,
    },
    lastResult: verification,
    requirementType: "url_status",
    requiredForCompletion: args.required_for_completion !== false,
    status: verification.passed ? "passed" : "failed",
    target: url,
    taskId: task.id,
  });

  await logVerificationEvent({
    taskId: task.id,
    url,
    verification,
  });

  return {
    success: true,
    task_requirement: requirement,
    verification,
  };
}

function normalizeUrl(value: string | undefined): string {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error("public_site_verify requires url");
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Invalid URL '${normalized}'`);
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("public_site_verify only supports http or https URLs");
  }

  return parsed.toString();
}

function normalizeExpectation(value: string | undefined): Expectation {
  const normalized = String(value || "ok")
    .trim()
    .toLowerCase();

  if (normalized === "ok" || normalized === "unavailable") {
    return normalized;
  }

  throw new Error("public_site_verify expect must be ok|unavailable");
}

async function verifyPublicUrl(
  url: string,
  expected: Expectation
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    const body = await response.text();
    const passed =
      expected === "ok" ? response.ok : response.status >= 400;

    return {
      checked_at: new Date().toISOString(),
      content_type: response.headers.get("content-type"),
      final_url: response.url,
      passed,
      response_snippet: body.slice(0, 200),
      status: response.status,
      url,
    };
  } catch (error) {
    const passed = expected === "unavailable";
    return {
      checked_at: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      passed,
      status: null,
      url,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function logVerificationEvent(args: {
  taskId: string;
  url: string;
  verification: Record<string, unknown>;
}): Promise<void> {
  const db = getDb();
  const ctx = getAgentContext();
  const passed = args.verification.passed === true;

  const { error } = await db.from("events").insert({
    trace_id: ctx.trace_id,
    agent_id: ctx.agent_id,
    event_type: "public.site.verify",
    severity: passed ? "info" : "warning",
    scope_type: "task",
    scope_id: args.taskId,
    summary: passed
      ? `Verified public URL ${args.url}.`
      : `Public URL verification failed for ${args.url}.`,
    detail: args.verification,
  });

  if (error) {
    console.error("Failed to record public site verification event:", error);
  }
}
