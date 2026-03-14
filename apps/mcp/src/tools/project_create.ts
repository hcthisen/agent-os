import { getDb } from "../db.js";
import { requireCurrentTaskContext } from "../scope.js";
import { assertTaskMutationAllowed } from "../simulation.js";

export const projectCreateDef = {
  name: "project_create",
  description:
    "Create a project so tasks, artifacts, and memory can be grouped under a durable project record.",
  inputSchema: {
    type: "object" as const,
    properties: {
      slug: { type: "string" },
      display_name: { type: "string" },
      description: { type: "string" },
      repo_url: { type: "string" },
    },
    required: ["slug", "display_name"],
  },
};

export async function projectCreate(args: {
  slug: string;
  display_name: string;
  description?: string;
  repo_url?: string;
}): Promise<unknown> {
  await assertTaskMutationAllowed("project_create");
  await requireCurrentTaskContext();

  const db = getDb();
  const slug = String(args.slug || "").trim().toLowerCase();
  const displayName = String(args.display_name || "").trim();

  if (!slug || !displayName) {
    return { success: false, error: "slug and display_name are required" };
  }

  const { data, error } = await db
    .from("projects")
    .insert({
      description: String(args.description || "").trim(),
      display_name: displayName,
      repo_url: String(args.repo_url || "").trim() || null,
      slug,
    })
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, project: data };
}
