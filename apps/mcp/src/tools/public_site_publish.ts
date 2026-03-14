import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getDb } from "../db.js";
import { getAgentContext } from "../context.js";
import { requireCurrentTaskContext } from "../scope.js";
import { assertTaskMutationAllowed } from "../simulation.js";

const DEFAULT_SOURCE_CANDIDATES = [
  "sites/public/dist",
  "sites/public",
  "dist",
] as const;
const RELEASES_DIR_NAME = "releases";
const CURRENT_LINK_NAME = "current";
const RELEASES_TO_KEEP = 3;

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
          "When true, prune older releases after the new build has been atomically activated.",
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
  await assertTaskMutationAllowed("public_site_publish");
  const task = await requireCurrentTaskContext();
  const workspaceDir = process.env.WORKSPACE_DIR || process.cwd();
  const deploymentRoot = process.env.PUBLIC_LIVE_DIR;

  if (!deploymentRoot) {
    throw new Error("PUBLIC_LIVE_DIR is not configured for this runtime");
  }

  const sourceDir = await resolveSourceDir(workspaceDir, args.source_path);
  const pruneReleases = args.clear_existing !== false;
  const relativeSource = relativeToWorkspace(workspaceDir, sourceDir);
  const releaseId = createReleaseId();
  const releasesDir = join(deploymentRoot, RELEASES_DIR_NAME);
  const releaseDir = join(releasesDir, releaseId);

  await mkdir(deploymentRoot, { recursive: true });
  await ensureAtomicLayout(deploymentRoot);
  await mkdir(releasesDir, { recursive: true });
  await rm(releaseDir, { recursive: true, force: true });
  await cp(sourceDir, releaseDir, {
    recursive: true,
    force: true,
  });

  await activateRelease(deploymentRoot, releaseId);
  const retainedReleaseIds = pruneReleases
    ? await pruneOldReleases(releasesDir, releaseId)
    : await listReleaseIds(releasesDir);

  const fileCount = await countFiles(releaseDir);
  const publishedAt = new Date().toISOString();
  const publicSiteUrl = process.env.PUBLIC_SITE_URL || null;

  const { error: artifactError } = await db.from("artifacts").insert({
    name: args.name || `Published public site from ${relativeSource}`,
    artifact_type: "report",
    task_id: task.id,
    external_url: publicSiteUrl,
    metadata: {
      file_count: fileCount,
      published_at: publishedAt,
      prune_releases: pruneReleases,
      release_id: releaseId,
      retained_release_ids: retainedReleaseIds,
      source_path: relativeSource,
      target: "public_live_current",
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
    summary: `Published public release ${releaseId} with ${fileCount} file(s) from ${relativeSource}.`,
    detail: {
      file_count: fileCount,
      public_site_url: publicSiteUrl,
      published_at: publishedAt,
      prune_releases: pruneReleases,
      release_id: releaseId,
      retained_release_ids: retainedReleaseIds,
      source_path: relativeSource,
      workspace_dir: workspaceDir,
    },
  });

  if (eventError) {
    console.error("Failed to record public site publish event:", eventError);
  }

  return {
    success: true,
    file_count: fileCount,
    public_site_url: publicSiteUrl,
    published_at: publishedAt,
    prune_releases: pruneReleases,
    release_id: releaseId,
    retained_release_ids: retainedReleaseIds,
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

function createReleaseId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

async function ensureAtomicLayout(deploymentRoot: string): Promise<void> {
  const releasesDir = join(deploymentRoot, RELEASES_DIR_NAME);
  const currentLink = join(deploymentRoot, CURRENT_LINK_NAME);

  await mkdir(releasesDir, { recursive: true });

  const currentState = await getPathState(currentLink);
  if (currentState === "symlink") {
    return;
  }

  if (currentState === "directory") {
    const legacyReleaseId = `legacy-current-${createReleaseId()}`;
    const legacyReleaseDir = join(releasesDir, legacyReleaseId);
    await rename(currentLink, legacyReleaseDir);
    await swapCurrentLink(deploymentRoot, legacyReleaseDir, legacyReleaseId);
    return;
  }

  const rootEntries = await readdir(deploymentRoot, { withFileTypes: true }).catch(() => []);
  const legacyEntries = rootEntries.filter(
    (entry) => entry.name !== CURRENT_LINK_NAME && entry.name !== RELEASES_DIR_NAME
  );

  if (!legacyEntries.length) {
    return;
  }

  const legacyReleaseId = `legacy-root-${createReleaseId()}`;
  const legacyReleaseDir = join(releasesDir, legacyReleaseId);
  await mkdir(legacyReleaseDir, { recursive: true });

  for (const entry of legacyEntries) {
    await rename(join(deploymentRoot, entry.name), join(legacyReleaseDir, entry.name));
  }

  await swapCurrentLink(deploymentRoot, legacyReleaseDir, legacyReleaseId);
}

async function activateRelease(deploymentRoot: string, releaseId: string): Promise<void> {
  const releaseDir = join(deploymentRoot, RELEASES_DIR_NAME, releaseId);
  await swapCurrentLink(deploymentRoot, releaseDir, releaseId);
}

async function swapCurrentLink(
  deploymentRoot: string,
  releaseDir: string,
  releaseId: string
): Promise<void> {
  const currentLink = join(deploymentRoot, CURRENT_LINK_NAME);
  const tempLink = join(deploymentRoot, `.current-${releaseId}`);
  const relativeTarget = relative(deploymentRoot, releaseDir);

  await rm(tempLink, { force: true, recursive: true });
  await symlink(relativeTarget, tempLink, "dir");
  await rename(tempLink, currentLink);
}

async function getPathState(targetPath: string): Promise<"missing" | "directory" | "symlink"> {
  try {
    const targetStats = await lstat(targetPath);

    if (targetStats.isSymbolicLink()) {
      return "symlink";
    }

    if (targetStats.isDirectory()) {
      return "directory";
    }
  } catch {
    return "missing";
  }

  throw new Error(`Expected ${targetPath} to be a directory or symlink`);
}

async function listReleaseIds(releasesDir: string): Promise<string[]> {
  const entries = await readdir(releasesDir, { withFileTypes: true }).catch(() => []);

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

async function pruneOldReleases(releasesDir: string, activeReleaseId: string): Promise<string[]> {
  const releaseIds = await listReleaseIds(releasesDir);
  const retained = new Set<string>([activeReleaseId]);

  for (const releaseId of releaseIds) {
    if (retained.size >= RELEASES_TO_KEEP) {
      break;
    }

    retained.add(releaseId);
  }

  await Promise.all(
    releaseIds
      .filter((releaseId) => !retained.has(releaseId))
      .map((releaseId) =>
        rm(join(releasesDir, releaseId), { recursive: true, force: true })
      )
  );

  return [...retained].sort().reverse();
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
