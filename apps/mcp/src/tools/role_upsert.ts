import { getDb } from "../db.js";
import { requireCurrentTaskContext } from "../scope.js";
import { assertTaskMutationAllowed } from "../simulation.js";

export const roleUpsertDef = {
  name: "role_upsert",
  description:
    "Create or update a role definition, including its policy and handoff guidance.",
  inputSchema: {
    type: "object" as const,
    properties: {
      id: { type: "string" },
      display_name: { type: "string" },
      description: { type: "string" },
      policy_doc: { type: "string" },
      usage_summary: { type: "string" },
      handoff_when: { type: "string" },
      model: { type: "string" },
      effort: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
      max_concurrent_tasks: { type: "integer" },
      is_system_role: { type: "boolean" },
    },
    required: [
      "id",
      "display_name",
      "description",
      "policy_doc",
      "usage_summary",
      "handoff_when",
      "model",
      "effort",
    ],
  },
};

export async function roleUpsert(args: {
  id: string;
  display_name: string;
  description: string;
  policy_doc: string;
  usage_summary: string;
  handoff_when: string;
  model: string;
  effort: string;
  max_concurrent_tasks?: number;
  is_system_role?: boolean;
}): Promise<unknown> {
  await assertTaskMutationAllowed("role_upsert");
  await requireCurrentTaskContext();

  const db = getDb();
  const roleId = args.id.trim().toLowerCase();

  const { data: existing, error: existingError } = await db
    .from("roles")
    .select("id,is_system_role")
    .eq("id", roleId)
    .maybeSingle<{ id: string; is_system_role: boolean }>();

  if (existingError) {
    return { success: false, error: existingError.message };
  }

  const payload = {
    id: roleId,
    display_name: args.display_name.trim(),
    description: args.description.trim(),
    policy_doc: args.policy_doc.trim(),
    usage_summary: args.usage_summary.trim(),
    handoff_when: args.handoff_when.trim(),
    model: args.model.trim(),
    effort: args.effort.trim().toLowerCase(),
    max_concurrent_tasks: args.max_concurrent_tasks || 3,
    is_system_role: existing?.is_system_role ?? !!args.is_system_role,
  };

  if (existing?.id) {
    const { data, error } = await db
      .from("roles")
      .update(payload)
      .eq("id", roleId)
      .select()
      .single();

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, role: data, updated: true };
  }

  const { data, error } = await db.from("roles").insert(payload).select().single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, role: data, updated: false };
}
