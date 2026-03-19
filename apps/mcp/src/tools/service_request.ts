import { getAgentContext } from "../context.js";
import { getDb } from "../db.js";
import { requireCurrentTaskContext } from "../scope.js";
import { assertTaskMutationAllowed } from "../simulation.js";
import { callSupervisorControl } from "../supervisor-control.js";

const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const serviceRequestDef = {
  name: "service_request",
  description:
    "Make an authenticated HTTP request through an active Service Connection without exposing plaintext credentials inside the agent runtime. Binary responses can be returned as body_base64 or saved directly into the task workspace via output_path for media generation workflows.",
  inputSchema: {
    type: "object" as const,
    properties: {
      service_name: {
        type: "string",
        description: "Service Connection name, for example gohighlevel or github.",
      },
      method: {
        type: "string",
        description: "HTTP method. Defaults to GET.",
      },
      path: {
        type: "string",
        description:
          "Path relative to the service base URL, for example /contacts/search.",
      },
      url: {
        type: "string",
        description:
          "Optional full URL. When a service base URL exists, the origin must match it.",
      },
      headers: {
        type: "object",
        description:
          "Optional request headers. Do not put secrets here; auth is injected from the service credential.",
        additionalProperties: {
          type: "string",
        },
      },
      query: {
        type: "object",
        description: "Optional query string parameters.",
        additionalProperties: {
          type: "string",
        },
      },
      body: {
        description:
          "Optional request body. Objects and arrays are JSON encoded unless Content-Type is form-urlencoded.",
      },
      auth_mode: {
        type: "string",
        enum: ["bearer", "basic", "header", "none", "x-api-key"],
        description:
          "How to inject the stored credential. Defaults to bearer.",
      },
      auth_header_name: {
        type: "string",
        description:
          "Optional header name for auth_mode=header or auth_mode=x-api-key.",
      },
      auth_prefix: {
        type: "string",
        description:
          "Optional prefix for auth headers, for example 'Bearer ' or 'Basic '.",
      },
      credential_field: {
        type: "string",
        description:
          "Optional labeled credential field to use when the stored credential contains multiple key:value lines.",
      },
      allow_non_2xx: {
        type: "boolean",
        description:
          "When true, return non-2xx responses instead of raising an error.",
      },
      response_mode: {
        type: "string",
        enum: ["auto", "json", "text", "base64"],
        description:
          "How to decode the response body. Defaults to auto, which returns JSON/text when possible and base64 for binary payloads.",
      },
      output_path: {
        type: "string",
        description:
          "Optional workspace-relative file path. When provided for generated media or other large binary responses, the response body is saved directly to this file and the tool returns saved_output metadata instead of a large body_base64 payload.",
      },
      timeout_ms: {
        type: "number",
        description:
          "Optional request timeout in milliseconds. Defaults to 30000 and is clamped for safety.",
      },
    },
    required: ["service_name"],
  },
};

export async function serviceRequest(args: {
  allow_non_2xx?: boolean;
  auth_header_name?: string;
  auth_mode?: string;
  auth_prefix?: string;
  body?: unknown;
  credential_field?: string;
  headers?: Record<string, unknown>;
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
  output_path?: string;
  response_mode?: string;
  service_name?: string;
  timeout_ms?: number;
  url?: string;
}): Promise<unknown> {
  const db = getDb();
  const ctx = getAgentContext();
  const task = await requireCurrentTaskContext();
  const method = normalizeMethod(args.method);

  if (!READ_ONLY_METHODS.has(method)) {
    await assertTaskMutationAllowed("service_request");
  }

  const result = await callSupervisorControl<Record<string, unknown>>(
    "/control/service-request",
    {
      allow_non_2xx: args.allow_non_2xx === true,
      auth_header_name: args.auth_header_name,
      auth_mode: args.auth_mode,
      auth_prefix: args.auth_prefix,
      body: args.body,
      credential_field: args.credential_field,
      headers:
        args.headers && typeof args.headers === "object" ? args.headers : undefined,
      method,
      output_path: args.output_path,
      path: args.path,
      query: args.query,
      response_mode: args.response_mode,
      service_name: normalizeServiceName(args.service_name),
      task_id: task.id,
      timeout_ms: args.timeout_ms,
      url: args.url,
    }
  );

  await db.from("events").insert({
    trace_id: ctx.trace_id,
    agent_id: ctx.agent_id,
    event_type: "service.request",
    severity: result.success === false ? "warning" : "info",
    scope_type: "task",
    scope_id: task.id,
    summary: `${method} ${String(result.url || args.url || args.path || args.service_name || "service request")} -> ${String(
      result.status || "unknown"
    )}`,
    detail: {
      method,
      service_name: args.service_name,
      status: result.status || null,
      url: result.url || args.url || args.path || null,
    },
  });

  return result;
}

function normalizeMethod(value: string | undefined): string {
  const normalized = String(value || "GET")
    .trim()
    .toUpperCase();

  return normalized || "GET";
}

function normalizeServiceName(value: string | undefined): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (!normalized) {
    throw new Error("service_request requires service_name");
  }

  return normalized;
}
