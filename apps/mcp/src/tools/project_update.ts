import { getDb } from "../db.js";
import { enforceScope, requireCurrentTaskContext } from "../scope.js";
import { assertTaskMutationAllowed } from "../simulation.js";

export const projectUpdateDef = {
  name: "project_update",
  description:
    "Update an existing project record, such as its display name, description, slug, or repository URL.",
  inputSchema: {
    type: "object" as const,
    properties: {
      project_id: { type: "string" },
      slug: { type: "string" },
      display_name: { type: "string" },
      description: { type: "string" },
      repo_url: { type: "string" },
    },
    required: ["project_id"],
  },
};

export async function projectUpdate(args: {
  project_id: string;
  slug?: string;
  display_name?: string;
  description?: string;
  repo_url?: string;
}): Promise<unknown> {
  await assertTaskMutationAllowed("project_update");
  await requireCurrentTaskContext();

  const projectId = String(args.project_id || "").trim();
  if (!projectId) {
    return { success: false, error: "project_id is required" };
  }

  await enforceScope("project", projectId);

  const patch: Record<string, string | null> = {};
  if (typeof args.slug === "string") {
    patch.slug = args.slug.trim().toLowerCase();
  }
  if (typeof args.display_name === "string") {
    patch.display_name = args.display_name.trim();
  }
  if (typeof args.description === "string") {
    patch.description = args.description.trim();
  }
  if (typeof args.repo_url === "string") {
    patch.repo_url = args.repo_url.trim() || null;
  }

  if (!Object.keys(patch).length) {
    return { success: false, error: "No project fields were provided to update" };
  }

  const db = getDb();
  const { data, error } = await db
    .from("projects")
    .update(patch)
    .eq("id", projectId)
    .select()
    .single();

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, project: data };
}
