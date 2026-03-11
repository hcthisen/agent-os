import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { getDb } from "../db.js";
import { getAgentContext } from "../context.js";
import { requireCurrentTaskContext } from "../scope.js";

const DEFAULT_SOURCE_CANDIDATES = [
  "sites/public/dist",
  "sites/public",
  "dist",
] as const;

export const publicSitePublishDef = {
  name: "public_site_publish",
  description:
    "Publish static site files from the current task workspace to the live public domain served by the public service.",
  inputSchema: {
    type: "object" as const,
    properties: {
      source_path: {
        type: "string",
        description:
          "Relative path inside the current task workspace. Defaults to sites/public/dist, then sites/public, then dist.",
      },
      clear_existing: {
        type: "boolean",
        description:
          "When true, remove the current public site files before copying the new build.",
        default: true,
      },
      name: {
        type: "string",
        description: "Optional label stored with the publish artifact.",
      },
    },
  },
};

export async function publicSitePublish(args: {
  source_path?: string;
  clear_existing?: boolean;
  name?: string;
}): Promise<unknown> {
  const db = getDb();
  const ctx = getAgentContext();
  const task = await requireCurrentTaskContext();
  const workspaceDir = process.env.WORKSPACE_DIR || process.cwd();
  const publicLiveDir = process.env.PUBLIC_LIVE_DIR;

  if (!publicLiveDir) {
    throw new Error("PUBLIC_LIVE_DIR is not configured for this runtime");
  }

  const sourceDir = await resolveSourceDir(workspaceDir, args.source_path);
  const clearExisting = args.clear_existing !== false;

  await mkdir(publicLiveDir, { recursive: true });
  if (clearExisting) {
    await emptyDirectory(publicLiveDir);
  }

  await cp(sourceDir, publicLiveDir, {
    recursive: true,
    force: true,
  });

  const fileCount = await countFiles(publicLiveDir);
  const publishedAt = new Date().toISOString();
  const publicSiteUrl = process.env.PUBLIC_SITE_URL || null;
  const relativeSource = relativeToWorkspace(workspaceDir, sourceDir);

  const { error: artifactError } = await db.from("artifacts").insert({
    name: args.name || `Published public site from ${relativeSource}`,
    artifact_type: "report",
    task_id: task.id,
    external_url: publicSiteUrl,
    metadata: {
      clear_existing: clearExisting,
      file_count: fileCount,
      published_at: publishedAt,
      source_path: relativeSource,
      target: "public_live",
    },
    created_by: ctx.agent_id,
  });

  if (artifactError) {
    console.error("Failed to record public site publish artifact:", artifactError);
  }

  const { error: eventError } = await db.from("events").insert({
    trace_id: ctx.trace_id,
    agent_id: ctx.agent_id,
    event_type: "public.site.publish",
    severity: "info",
    scope_type: "task",
    scope_id: task.id,
    summary: `Published ${fileCount} public-site file(s) from ${relativeSource}.`,
    detail: {
      clear_existing: clearExisting,
      file_count: fileCount,
      public_site_url: publicSiteUrl,
      published_at: publishedAt,
      source_path: relativeSource,
      workspace_dir: workspaceDir,
    },
  });

  if (eventError) {
    console.error("Failed to record public site publish event:", eventError);
  }

  return {
    success: true,
    clear_existing: clearExisting,
    file_count: fileCount,
    public_site_url: publicSiteUrl,
    published_at: publishedAt,
    source_path: relativeSource,
  };
}

async function resolveSourceDir(
  workspaceDir: string,
  sourcePath?: string
): Promise<string> {
  const candidates = sourcePath
    ? [sourcePath]
    : [...DEFAULT_SOURCE_CANDIDATES];

  for (const candidate of candidates) {
    const resolved = resolveWorkspacePath(workspaceDir, candidate);
    try {
      const sourceStats = await stat(resolved);
      if (sourceStats.isDirectory()) {
        return resolved;
      }
    } catch {
      // Try the next candidate.
    }
  }

  if (sourcePath) {
    throw new Error(
      `Publish source '${sourcePath}' was not found as a directory under the current task workspace`
    );
  }

  throw new Error(
    `No publishable public site directory was found. Checked: ${DEFAULT_SOURCE_CANDIDATES.join(", ")}`
  );
}

function resolveWorkspacePath(workspaceDir: string, relativePath: string): string {
  if (!relativePath.trim()) {
    throw new Error("source_path cannot be empty");
  }

  if (isAbsolute(relativePath)) {
    throw new Error("source_path must be relative to the current task workspace");
  }

  const resolved = resolve(workspaceDir, relativePath);
  const normalizedWorkspace = ensureTrailingSeparator(resolve(workspaceDir));
  const normalizedResolved = ensureTrailingSeparator(resolved);

  if (!normalizedResolved.startsWith(normalizedWorkspace)) {
    throw new Error("source_path must stay within the current task workspace");
  }

  return resolved;
}

function ensureTrailingSeparator(value: string): string {
  return value.endsWith(sep) ? value : `${value}${sep}`;
}

function relativeToWorkspace(workspaceDir: string, absolutePath: string): string {
  return absolutePath.slice(ensureTrailingSeparator(resolve(workspaceDir)).length);
}

async function emptyDirectory(targetDir: string): Promise<void> {
  const entries = await readdir(targetDir, { withFileTypes: true }).catch(() => []);

  await Promise.all(
    entries.map((entry) =>
      rm(join(targetDir, entry.name), { recursive: true, force: true })
    )
  );
}

async function countFiles(targetDir: string): Promise<number> {
  const entries = await readdir(targetDir, { withFileTypes: true });
  let total = 0;

  for (const entry of entries) {
    const entryPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      total += await countFiles(entryPath);
      continue;
    }

    if (entry.isFile()) {
      total += 1;
    }
  }

  return total;
}
