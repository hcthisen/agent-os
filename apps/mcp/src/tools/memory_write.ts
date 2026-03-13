import { getDb } from "../db.js";
import { getAgentContext } from "../context.js";
import { enforceScope } from "../scope.js";

export const memoryWriteDef = {
  name: "memory_write",
  description:
    "Write a structured memory (episodic or semantic). Optionally supersedes an existing memory.",
  inputSchema: {
    type: "object" as const,
    properties: {
      layer: {
        type: "string",
        enum: ["episodic", "semantic", "procedural"],
      },
      scope_type: {
        type: "string",
        enum: ["task", "project", "customer", "role", "department", "company"],
      },
      scope_id: { type: "string" },
      subject: {
        type: "string",
        description: "Short label for retrieval",
      },
      content: { type: "string", description: "The fact or event" },
      tags: { type: "array", items: { type: "string" } },
      confidence: {
        type: "number",
        description: "0.0-1.0, default 1.0",
      },
      source_event_id: { type: "string" },
      supersedes_memory_id: {
        type: "string",
        description: "ID of memory this replaces",
      },
    },
    required: ["layer", "scope_type", "scope_id", "subject", "content"],
  },
};

export async function memoryWrite(args: {
  layer: string;
  scope_type: string;
  scope_id: string;
  subject: string;
  content: string;
  tags?: string[];
  confidence?: number;
  source_event_id?: string;
  supersedes_memory_id?: string;
}): Promise<unknown> {
  const db = getDb();
  const ctx = getAgentContext();

  await enforceScope(args.scope_type, args.scope_id);

  if (args.supersedes_memory_id) {
    const { data: previous, error: previousError } = await db
      .from("memories")
      .select("id, scope_type, scope_id")
      .eq("id", args.supersedes_memory_id)
      .maybeSingle<{ id: string; scope_type: string; scope_id: string }>();

    if (previousError) {
      return { success: false, error: previousError.message };
    }

    if (!previous) {
      return {
        success: false,
        error: `Memory '${args.supersedes_memory_id}' does not exist`,
      };
    }

    await enforceScope(previous.scope_type, previous.scope_id);
    if (
      previous.scope_type !== args.scope_type ||
      previous.scope_id !== args.scope_id
    ) {
      return {
        success: false,
        error: "Superseded memory must be in the same scope as the replacement memory",
      };
    }

    await db
      .from("memories")
      .update({ is_active: false })
      .eq("id", args.supersedes_memory_id);

    await db
      .from("memory_chunks")
      .delete()
      .eq("source_type", "memory")
      .eq("source_id", args.supersedes_memory_id);
  }

  const { data, error } = await db
    .from("memories")
    .insert({
      layer: args.layer,
      scope_type: args.scope_type,
      scope_id: args.scope_id,
      subject: args.subject,
      content: args.content,
      tags: args.tags || [],
      confidence: args.confidence ?? 1.0,
      source_event_id: args.source_event_id || null,
      source_agent_id: ctx.agent_id,
      superseded_by: null,
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  if (args.supersedes_memory_id) {
    await db
      .from("memories")
      .update({ superseded_by: data.id })
      .eq("id", args.supersedes_memory_id);
  }

  const { error: chunkError } = await db.from("memory_chunks").insert({
    source_type: "memory",
    source_id: data.id,
    scope_type: args.scope_type,
    scope_id: args.scope_id,
    content: `${args.subject}: ${args.content}`,
  });

  if (chunkError) {
    return {
      success: true,
      memory: data,
      warning: `Memory written but chunk creation failed: ${chunkError.message}`,
    };
  }

  return { success: true, memory: data };
}
