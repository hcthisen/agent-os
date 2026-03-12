import { getDb } from "../db.js";
import { requireCurrentTaskContext } from "../scope.js";

export const agentUpsertDef = {
  name: "agent_upsert",
  description:
    "Create or update a persistent agent identity and assign it to a role.",
  inputSchema: {
    type: "object" as const,
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      role_id: { type: "string" },
      status: {
        type: "string",
        enum: ["active", "paused", "disabled"],
        default: "active",
      },
      config: {
        type: "object",
        additionalProperties: true,
      },
    },
    required: ["name", "role_id"],
  },
};

export async function agentUpsert(args: {
  id?: string;
  name: string;
  role_id: string;
  status?: string;
  config?: Record<string, unknown>;
}): Promise<unknown> {
  await requireCurrentTaskContext();

  const db = getDb();
  const agentName = args.name.trim();
  const requestedId = args.id?.trim() || "";
  let existing: { id: string; name: string } | null = null;

  if (requestedId) {
    const { data, error } = await db
      .from("agents")
      .select("id,name")
      .eq("id", requestedId)
      .maybeSingle<{ id: string; name: string }>();

    if (error) {
      return { success: false, error: error.message };
    }

    existing = data || null;
  }

  if (!existing) {
    const { data, error } = await db
      .from("agents")
      .select("id,name")
      .eq("name", agentName)
      .maybeSingle<{ id: string; name: string }>();

    if (error) {
      return { success: false, error: error.message };
    }

    existing = data || null;
  }

  const payload = {
    name: agentName,
    role_id: args.role_id.trim().toLowerCase(),
    status: (args.status || "active").trim().toLowerCase(),
    config: args.config || {},
  };

  if (existing?.id) {
    const { data, error } = await db
      .from("agents")
      .update(payload)
      .eq("id", existing.id)
      .select()
      .single();

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, agent: data, updated: true };
  }

  const { data, error } = await db.from("agents").insert(payload).select().single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, agent: data, updated: false };
}
