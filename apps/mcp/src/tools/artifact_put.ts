import { getDb } from "../db.js";
import { getAgentContext } from "../context.js";
import { enforceScope, requireCurrentTaskContext } from "../scope.js";

export const artifactPutDef = {
  name: "artifact_put",
  description: "Register a file, doc, PR, report, or other work product.",
  inputSchema: {
    type: "object" as const,
    properties: {
      name: { type: "string" },
      artifact_type: {
        type: "string",
        description:
          "file, pr, doc, report, invoice, screenshot, contract, ticket, audio",
      },
      task_id: { type: "string" },
      project_id: { type: "string" },
      storage_path: {
        type: "string",
        description: "Supabase Storage path",
      },
      external_url: {
        type: "string",
        description: "GitHub PR, Google Doc, etc.",
      },
      mime_type: { type: "string" },
      size_bytes: { type: "number" },
      metadata: { type: "object" },
    },
    required: ["name", "artifact_type"],
  },
};

export async function artifactPut(args: {
  name: string;
  artifact_type: string;
  task_id?: string;
  project_id?: string;
  storage_path?: string;
  external_url?: string;
  mime_type?: string;
  size_bytes?: number;
  metadata?: Record<string, unknown>;
}): Promise<unknown> {
  const db = getDb();
  const ctx = getAgentContext();
  let taskId = args.task_id || null;
  const projectId = args.project_id || null;

  if (taskId) {
    await enforceScope("task", taskId);
  }

  if (projectId) {
    await enforceScope("project", projectId);
  }

  if (!taskId && !projectId) {
    taskId = (await requireCurrentTaskContext()).id;
  }

  const { data, error } = await db
    .from("artifacts")
    .insert({
      name: args.name,
      artifact_type: args.artifact_type,
      task_id: taskId,
      project_id: projectId,
      storage_path: args.storage_path || null,
      external_url: args.external_url || null,
      mime_type: args.mime_type || null,
      size_bytes: args.size_bytes || null,
      metadata: args.metadata || {},
      created_by: ctx.agent_id,
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, artifact: data };
}
