import { createHmac } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { config } from "./config.js";
import { getDb } from "./db.js";

const DELIVERY_ARTIFACT_TYPE = "delivery_page";
const DELIVERY_ARTIFACT_NAME = "operator-result-page";
const DELIVERY_TOKEN_PURPOSE = "operator-result";
const DELIVERY_TOKEN_SECRET_FALLBACK = "agent-os-admin";
const IMAGE_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp"]);
const REPORT_EXTENSIONS = new Set([".html", ".markdown", ".md", ".txt"]);
const MAX_SOURCE_CHARS = 80000;

interface DeliveryTask {
  assigned_role: string;
  completed_at: string | null;
  id: string;
  last_handoff_note: string | null;
  objective: string | null;
  title: string;
  updated_at: string;
}

interface DeliveryArtifactRow {
  artifact_type: string;
  created_at: string;
  external_url: string | null;
  id: string;
  metadata: Record<string, unknown> | null;
  mime_type: string | null;
  name: string;
  storage_path: string | null;
  task_id: string | null;
}

interface DeliveryArtifactReference {
  artifact_type: string;
  external_url: string | null;
  name: string;
  storage_path: string | null;
  task_id: string | null;
}

interface DeliveryEvidenceImage {
  caption: string;
  externalUrl: string | null;
  filePath: string | null;
  name: string;
  taskId: string | null;
}

interface DeliveryBundle {
  artifactRefs: DeliveryArtifactReference[];
  evidenceImages: DeliveryEvidenceImage[];
  html: string;
  plainText: string;
  summary: string;
  title: string;
}

interface DeliveryLink {
  path: string;
  url: string | null;
}

export async function maybePublishOperatorResultPage(args: {
  deliveryChannel: "admin_chat" | "telegram";
  requestTasks: DeliveryTask[];
  rootTaskId: string;
  rootTaskTitle: string;
  selectedTask: DeliveryTask;
  summary: string;
}): Promise<DeliveryLink | null> {
  const deliveryLink = buildOperatorResultLink(args.rootTaskId);
  if (!deliveryLink) {
    return null;
  }

  const artifacts = await loadArtifactsForTasks(args.requestTasks.map((task) => task.id));
  if (!shouldPublishRichResultPage(args.summary, args.selectedTask, artifacts, args.deliveryChannel)) {
    return null;
  }

  const bundle = await buildDeliveryBundle({
    artifacts,
    rootTaskId: args.rootTaskId,
    requestTasks: args.requestTasks,
    rootTaskTitle: args.rootTaskTitle,
    selectedTask: args.selectedTask,
    summary: args.summary,
  });

  await upsertDeliveryArtifact(
    args.rootTaskId,
    deliveryLink,
    bundle,
    args.requestTasks.map((task) => task.id)
  );
  return deliveryLink;
}

function buildOperatorResultLink(taskId: string): DeliveryLink | null {
  if (!taskId) {
    return null;
  }

  const baseUrl = String(
    process.env.ADMIN_PUBLIC_URL || process.env.SERVICE_URL_ADMIN || ""
  )
    .trim()
    .replace(/\/+$/, "");
  const secret = resolveDeliveryTokenSecret();

  const token = createHmac("sha256", secret)
    .update(`${DELIVERY_TOKEN_PURPOSE}:${taskId}`)
    .digest("base64url");

  const path = `/deliveries/${taskId}/${token}`;
  return {
    path,
    url: baseUrl ? `${baseUrl}${path}` : null,
  };
}

async function loadArtifactsForTasks(taskIds: string[]): Promise<DeliveryArtifactRow[]> {
  const normalizedTaskIds = [...new Set(taskIds.filter(Boolean))];
  if (!normalizedTaskIds.length) {
    return [];
  }

  const db = getDb();
  const { data, error } = await db
    .from("artifacts")
    .select(
      "id,task_id,artifact_type,name,storage_path,external_url,mime_type,metadata,created_at"
    )
    .in("task_id", normalizedTaskIds)
    .order("created_at", { ascending: false })
    .returns<DeliveryArtifactRow[]>();

  if (error) {
    console.error("Failed to load artifacts for operator result delivery:", error);
    return [];
  }

  return data || [];
}

function shouldPublishRichResultPage(
  summary: string,
  selectedTask: DeliveryTask,
  artifacts: DeliveryArtifactRow[],
  deliveryChannel: "admin_chat" | "telegram"
): boolean {
  const handoffNote = String(selectedTask.last_handoff_note || "").trim();
  if (
    artifacts.some((artifact) => artifact.artifact_type === "report" || artifact.artifact_type === "doc")
  ) {
    return true;
  }

  if (artifacts.length >= 3) {
    return true;
  }

  if (looksLikeRichResultTask(selectedTask)) {
    return true;
  }

  if (
    /\bdry-?run example\b/i.test(handoffNote) ||
    /```/.test(handoffNote) ||
    handoffNote.length > 500
  ) {
    return true;
  }

  const threshold = deliveryChannel === "telegram" ? 180 : 260;
  return String(summary || "").trim().length > threshold;
}

function looksLikeRichResultTask(task: DeliveryTask): boolean {
  const haystack = `${task.title || ""} ${task.objective || ""}`;
  return /\b(review|audit|report|findings|analysis|research|plan|recommend(?:ation|ations)?)\b/i.test(
    haystack
  );
}

async function buildDeliveryBundle(args: {
  artifacts: DeliveryArtifactRow[];
  rootTaskId: string;
  requestTasks: DeliveryTask[];
  rootTaskTitle: string;
  selectedTask: DeliveryTask;
  summary: string;
}): Promise<DeliveryBundle> {
  const primaryArtifact = pickPrimaryArtifact(args.artifacts, args.selectedTask.id);
  const sourceText =
    (await readPrimaryArtifactText(primaryArtifact)) ||
    (await readWorkspaceReportFallback(args.requestTasks));
  const derivedSummary =
    summarizeSourceText(sourceText) ||
    summarizeHandoff(args.selectedTask.last_handoff_note) ||
    args.summary;
  const reportHtml = sourceText
    ? renderMarkdownishToHtml(sourceText)
    : renderSummaryFallback(derivedSummary, args.selectedTask.last_handoff_note);
  const artifactRefs = args.artifacts
    .filter((artifact) => artifact.artifact_type !== DELIVERY_ARTIFACT_TYPE)
    .slice(0, 20)
    .map((artifact) => ({
      artifact_type: artifact.artifact_type,
      external_url: artifact.external_url,
      name: artifact.name,
      storage_path: artifact.storage_path,
      task_id: artifact.task_id,
    }));
  const evidenceImages = await collectEvidenceImages({
    artifacts: args.artifacts,
    primaryArtifact,
    rootTaskId: args.rootTaskId,
    requestTasks: args.requestTasks,
    sourceText,
  });
  const title = buildDeliveryTitle(args.rootTaskTitle, args.selectedTask);
  const plainText = buildPlainTextDelivery({
    artifactRefs,
    evidenceImages,
    selectedTask: args.selectedTask,
    sourceText,
    summary: derivedSummary,
  });

  return {
    artifactRefs,
    evidenceImages,
    html: buildDeliveryHtmlDocument({
      artifactRefs,
      evidenceImages,
      primaryArtifact,
      reportHtml,
      selectedTask: args.selectedTask,
      summary: derivedSummary,
      title,
    }),
    plainText,
    summary: trimToLength(derivedSummary, 800),
    title,
  };
}

function pickPrimaryArtifact(
  artifacts: DeliveryArtifactRow[],
  preferredTaskId: string
): DeliveryArtifactRow | null {
  const ranked = artifacts
    .filter((artifact) => artifact.artifact_type === "report" || artifact.artifact_type === "doc")
    .sort((left, right) => {
      const leftPreferred = left.task_id === preferredTaskId ? 1 : 0;
      const rightPreferred = right.task_id === preferredTaskId ? 1 : 0;
      if (rightPreferred !== leftPreferred) {
        return rightPreferred - leftPreferred;
      }

      return right.created_at.localeCompare(left.created_at);
    });

  return ranked[0] || null;
}

async function readPrimaryArtifactText(
  artifact: DeliveryArtifactRow | null
): Promise<string | null> {
  if (!artifact?.storage_path || !artifact.task_id) {
    return null;
  }

  const extension = extname(artifact.storage_path).toLowerCase();
  if (!REPORT_EXTENSIONS.has(extension)) {
    return null;
  }

  const workspaceRoot = resolve(config.workspacesDir, artifact.task_id);
  const absolutePath = resolve(workspaceRoot, artifact.storage_path);
  if (!isPathInsideRoot(absolutePath, workspaceRoot)) {
    return null;
  }

  try {
    const content = await readFile(absolutePath, "utf8");
    return content.slice(0, MAX_SOURCE_CHARS);
  } catch {
    return null;
  }
}

async function readWorkspaceReportFallback(
  requestTasks: DeliveryTask[]
): Promise<string | null> {
  for (const task of requestTasks) {
    const reportPathCandidates = extractReferencedWorkspaceReportPaths(
      task.last_handoff_note
    );
    for (const relativePath of reportPathCandidates) {
      const content = await readWorkspaceTextFile(task.id, relativePath);
      if (content) {
        return content;
      }
    }

    const discoveredReportPaths = await findWorkspaceReportFiles(task.id);
    for (const relativePath of discoveredReportPaths) {
      const content = await readWorkspaceTextFile(task.id, relativePath);
      if (content) {
        return content;
      }
    }
  }

  return null;
}

async function readWorkspaceTextFile(
  taskId: string,
  relativePath: string
): Promise<string | null> {
  const extension = extname(relativePath).toLowerCase();
  if (!REPORT_EXTENSIONS.has(extension)) {
    return null;
  }

  const workspaceRoot = resolve(config.workspacesDir, taskId);
  const absolutePath = resolve(workspaceRoot, relativePath);
  if (!isPathInsideRoot(absolutePath, workspaceRoot)) {
    return null;
  }

  try {
    const content = await readFile(absolutePath, "utf8");
    return content.slice(0, MAX_SOURCE_CHARS);
  } catch {
    return null;
  }
}

function extractReferencedWorkspaceReportPaths(note: string | null): string[] {
  const paths = new Set<string>();
  const pathPattern =
    /\b((?:artifacts|reports|evidence|task-artifacts\/review|task-artifacts\/reports)\/[^)\s]+\.(?:html|markdown|md|txt))\b/gim;

  for (const match of String(note || "").matchAll(pathPattern)) {
    const candidate = String(match[1] || "").trim();
    if (candidate) {
      paths.add(candidate);
    }
  }

  return [...paths];
}

async function findWorkspaceReportFiles(taskId: string): Promise<string[]> {
  const candidates = [
    "artifacts",
    "reports",
    "evidence",
    "task-artifacts/review",
    "task-artifacts/reports",
  ];
  const matches: string[] = [];

  for (const candidate of candidates) {
    const found = await listFilesRecursively(resolve(config.workspacesDir, taskId, candidate), 2);
    for (const absolutePath of found) {
      const extension = extname(absolutePath).toLowerCase();
      if (!REPORT_EXTENSIONS.has(extension)) {
        continue;
      }

      const workspaceRoot = resolve(config.workspacesDir, taskId);
      if (!isPathInsideRoot(absolutePath, workspaceRoot)) {
        continue;
      }

      matches.push(absolutePath.slice(workspaceRoot.length + 1).replace(/\\/g, "/"));
    }
  }

  return matches.sort();
}

async function collectEvidenceImages(args: {
  artifacts: DeliveryArtifactRow[];
  primaryArtifact: DeliveryArtifactRow | null;
  rootTaskId: string;
  requestTasks: DeliveryTask[];
  sourceText: string | null;
}): Promise<DeliveryEvidenceImage[]> {
  const evidence = new Map<string, DeliveryEvidenceImage>();
  const defaultTaskId = args.primaryArtifact?.task_id || null;

  const addEvidence = (candidate: DeliveryEvidenceImage | null) => {
    if (!candidate) {
      return;
    }

    const key = `${candidate.taskId || "external"}::${
      candidate.externalUrl || candidate.filePath || candidate.name
    }`;
    if (evidence.has(key)) {
      return;
    }

    evidence.set(key, candidate);
  };

  for (const artifact of args.artifacts) {
    if (!isImageArtifact(artifact)) {
      continue;
    }

    addEvidence(buildArtifactEvidenceImage(args.rootTaskId, artifact));
  }

  for (const reference of extractInlineImageReferences(args.sourceText)) {
    if (looksLikeExternalUrl(reference.path)) {
      addEvidence({
        caption: reference.caption || buildEvidenceCaption(reference.path),
        externalUrl: reference.path,
        filePath: null,
        name: reference.caption || buildEvidenceCaption(reference.path),
        taskId: null,
      });
      continue;
    }

    if (!defaultTaskId) {
      continue;
    }

    addEvidence({
      caption: reference.caption || buildEvidenceCaption(reference.path),
      externalUrl: null,
      filePath: buildDeliveryFilePath(args.rootTaskId, defaultTaskId, reference.path),
      name: reference.caption || buildEvidenceCaption(reference.path),
      taskId: defaultTaskId,
    });
  }

  if (!evidence.size) {
    for (const workspaceImage of await collectWorkspaceEvidenceImages(
      args.requestTasks,
      args.rootTaskId
    )) {
      addEvidence(workspaceImage);
    }
  }

  return [...evidence.values()].slice(0, 8);
}

function buildArtifactEvidenceImage(
  rootTaskId: string,
  artifact: DeliveryArtifactRow
): DeliveryEvidenceImage | null {
  if (artifact.external_url) {
    return {
      caption: buildEvidenceCaption(artifact.name || artifact.external_url),
      externalUrl: artifact.external_url,
      filePath: null,
      name: artifact.name || "Evidence image",
      taskId: artifact.task_id,
    };
  }

  if (!artifact.storage_path || !artifact.task_id) {
    return null;
  }

  return {
    caption: buildEvidenceCaption(artifact.name || artifact.storage_path),
    externalUrl: null,
    filePath: buildDeliveryFilePath(rootTaskId, artifact.task_id, artifact.storage_path),
    name: artifact.name || artifact.storage_path,
    taskId: artifact.task_id,
  };
}

function buildDeliveryFilePath(
  rootTaskId: string,
  taskId: string,
  relativePath: string
): string {
  return `/deliveries/${rootTaskId}/${signDeliveryToken(rootTaskId)}/file/${taskId}/${encodePathSegmentPath(
    relativePath
  )}`;
}

function encodePathSegmentPath(value: string): string {
  return String(value || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function extractInlineImageReferences(
  sourceText: string | null
): Array<{ caption: string; path: string }> {
  const matches: Array<{ caption: string; path: string }> = [];
  const seen = new Set<string>();
  const markdownImagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const markdownLinkPattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  const loosePathPattern =
    /(?:^|[\s(])((?:artifacts|evidence|screenshots|images)\/[^)\s]+\.(?:gif|jpe?g|png|svg|webp))(?:$|[\s)])/gim;

  const pushMatch = (caption: string, path: string) => {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath || !looksLikeImagePath(normalizedPath) || seen.has(normalizedPath)) {
      return;
    }

    seen.add(normalizedPath);
    matches.push({
      caption: String(caption || "").trim(),
      path: normalizedPath,
    });
  };

  const source = String(sourceText || "");
  for (const match of source.matchAll(markdownImagePattern)) {
    pushMatch(match[1] || "", match[2] || "");
  }
  for (const match of source.matchAll(markdownLinkPattern)) {
    pushMatch(match[1] || "", match[2] || "");
  }
  for (const match of source.matchAll(loosePathPattern)) {
    pushMatch("", match[1] || "");
  }

  return matches;
}

function buildEvidenceCaption(value: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "Evidence image";
  }

  const withoutPath = trimmed.split(/[\\/]/).pop() || trimmed;
  const withoutExtension = withoutPath.replace(/\.[a-z0-9]+$/i, "");
  return withoutExtension.replace(/[-_]+/g, " ").trim() || "Evidence image";
}

function isImageArtifact(artifact: DeliveryArtifactRow): boolean {
  if (artifact.mime_type && artifact.mime_type.toLowerCase().startsWith("image/")) {
    return true;
  }

  if (artifact.storage_path) {
    return IMAGE_EXTENSIONS.has(extname(artifact.storage_path).toLowerCase());
  }

  if (artifact.external_url) {
    return looksLikeImagePath(artifact.external_url);
  }

  return false;
}

function looksLikeImagePath(value: string): boolean {
  const pathname = String(value || "").split("?")[0].toLowerCase();
  return [...IMAGE_EXTENSIONS].some((extension) => pathname.endsWith(extension));
}

function looksLikeExternalUrl(value: string): boolean {
  return /^https?:\/\//i.test(String(value || "").trim());
}

async function collectWorkspaceEvidenceImages(
  requestTasks: DeliveryTask[],
  rootTaskId: string
): Promise<DeliveryEvidenceImage[]> {
  const images: DeliveryEvidenceImage[] = [];
  const candidateDirs = [
    "artifacts/browser",
    "artifacts/screenshots",
    "artifacts/evidence",
    "task-artifacts/screenshots",
    "task-artifacts/browser",
    "task-artifacts/evidence",
    "screenshots",
    "evidence",
  ];

  for (const task of requestTasks) {
    for (const dir of candidateDirs) {
      const absoluteDir = resolve(config.workspacesDir, task.id, dir);
      const files = await listFilesRecursively(absoluteDir, 2);
      for (const absolutePath of files) {
        if (!looksLikeImagePath(absolutePath)) {
          continue;
        }

        const workspaceRoot = resolve(config.workspacesDir, task.id);
        if (!isPathInsideRoot(absolutePath, workspaceRoot)) {
          continue;
        }

        const relativePath = absolutePath
          .slice(workspaceRoot.length + 1)
          .replace(/\\/g, "/");
        images.push({
          caption: buildEvidenceCaption(relativePath),
          externalUrl: null,
          filePath: buildDeliveryFilePath(rootTaskId, task.id, relativePath),
          name: relativePath,
          taskId: task.id,
        });
      }
    }
  }

  return images;
}

async function listFilesRecursively(
  absoluteDir: string,
  maxDepth: number
): Promise<string[]> {
  if (maxDepth < 0) {
    return [];
  }

  try {
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
      const nextPath = resolve(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await listFilesRecursively(nextPath, maxDepth - 1)));
        continue;
      }
      if (entry.isFile()) {
        results.push(nextPath);
      }
    }
    return results;
  } catch {
    return [];
  }
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const normalizedRoot = ensureTrailingSeparator(resolve(rootPath));
  const normalizedTarget = resolve(targetPath);
  return normalizedTarget === resolve(rootPath) || normalizedTarget.startsWith(normalizedRoot);
}

function ensureTrailingSeparator(value: string): string {
  return value.endsWith(sep) ? value : `${value}${sep}`;
}

function summarizeSourceText(sourceText: string | null): string | null {
  if (!sourceText) {
    return null;
  }

  const sections = parseMarkdownSections(sourceText);
  const summary =
    findSectionParagraph(sections, ["executive summary", "summary", "overview"]) ||
    extractFirstParagraph(cleanMarkdownText(sourceText));
  const findings = findSectionBullets(sections, [
    "key findings",
    "findings",
    "recommendations",
    "top recommendations",
    "priority actions",
    "next steps",
  ]);

  if (summary && findings.length) {
    return trimToLength(
      `${summary} Top actions: ${findings.slice(0, 3).join("; ")}.`,
      480
    );
  }

  if (summary) {
    return trimToLength(summary, 420);
  }

  if (findings.length) {
    return trimToLength(findings.slice(0, 4).join("; "), 420);
  }

  return trimToLength(cleanMarkdownText(sourceText), 420);
}

function summarizeHandoff(note: string | null): string | null {
  const text = String(note || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return null;
  }

  const changedMatch = text.match(/What changed:\s*(.*?)(?=\s+[A-Z][^:]{1,40}:|$)/i);
  if (changedMatch?.[1]) {
    return trimToLength(changedMatch[1].trim(), 360);
  }

  return trimToLength(text, 360);
}

function buildDeliveryTitle(rootTaskTitle: string, selectedTask: DeliveryTask): string {
  const cleanedRoot = String(rootTaskTitle || "").replace(/^Process message:\s*/i, "").trim();
  return cleanedRoot || selectedTask.title || "Task Result";
}

function buildPlainTextDelivery(args: {
  artifactRefs: DeliveryArtifactReference[];
  evidenceImages: DeliveryEvidenceImage[];
  selectedTask: DeliveryTask;
  sourceText: string | null;
  summary: string;
}): string {
  const lines = [
    args.selectedTask.title ? `Result: ${args.selectedTask.title}` : "Result",
    "",
    args.summary,
  ];

  if (args.sourceText) {
    lines.push("", cleanMarkdownText(args.sourceText));
  }

  if (args.artifactRefs.length) {
    lines.push("", "Related evidence:");
    for (const artifact of args.artifactRefs.slice(0, 10)) {
      lines.push(`- ${artifact.name} [${artifact.artifact_type}]`);
    }
  }

  if (args.evidenceImages.length) {
    lines.push("", "Embedded screenshot evidence:");
    for (const image of args.evidenceImages.slice(0, 6)) {
      lines.push(`- ${image.caption || image.name}`);
    }
  }

  return trimToLength(lines.filter(Boolean).join("\n"), MAX_SOURCE_CHARS);
}

function buildDeliveryHtmlDocument(args: {
  artifactRefs: DeliveryArtifactReference[];
  evidenceImages: DeliveryEvidenceImage[];
  primaryArtifact: DeliveryArtifactRow | null;
  reportHtml: string;
  selectedTask: DeliveryTask;
  summary: string;
  title: string;
}): string {
  const screenshotEvidenceHtml = args.evidenceImages.length
    ? `<section class="card"><h2>Screenshot Evidence</h2><div class="evidence-grid">${args.evidenceImages
        .map((image) => {
          const imageSrc = image.externalUrl || image.filePath;
          if (!imageSrc) {
            return "";
          }

          const linkMarkup = image.externalUrl
            ? `<p class="evidence-link"><a href="${escapeHtmlAttribute(image.externalUrl)}" target="_blank" rel="noreferrer">Open original</a></p>`
            : "";

          return `<figure class="evidence-card">
            <img src="${escapeHtmlAttribute(imageSrc)}" alt="${escapeHtmlAttribute(
              image.caption || image.name
            )}" loading="lazy" />
            <figcaption>${escapeHtml(image.caption || image.name)}</figcaption>
            ${linkMarkup}
          </figure>`;
        })
        .filter(Boolean)
        .join("")}</div></section>`
    : "";
  const evidenceHtml = args.artifactRefs.length
    ? `<section class="card"><h2>Related Evidence</h2><ul class="evidence-list">${args.artifactRefs
        .map((artifact) => {
          const externalLink = artifact.external_url
            ? ` <a href="${escapeHtmlAttribute(artifact.external_url)}" target="_blank" rel="noreferrer">Open link</a>`
            : "";
          const location = artifact.storage_path
            ? `<div class="artifact-path">${escapeHtml(artifact.storage_path)}</div>`
            : "";
          return `<li><strong>${escapeHtml(artifact.name)}</strong> <span class="artifact-type">${escapeHtml(
            artifact.artifact_type
          )}</span>${externalLink}${location}</li>`;
        })
        .join("")}</ul></section>`
    : "";

  const sourceMeta = args.primaryArtifact
    ? `<p class="source-meta">Primary source: ${escapeHtml(args.primaryArtifact.name)}</p>`
    : "";
  const completedAt =
    args.selectedTask.completed_at || args.selectedTask.updated_at || new Date().toISOString();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <title>${escapeHtml(args.title)}</title>
    <style>
      :root {
        --bg: #f4f0e6;
        --card: #fffaf0;
        --text: #1f1f18;
        --muted: #5f5a4f;
        --line: #d8cfbd;
        --accent: #2c6e49;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        background: radial-gradient(circle at top, #fff7e8 0%, var(--bg) 55%, #ede6d7 100%);
        color: var(--text);
        line-height: 1.6;
      }
      main {
        max-width: 920px;
        margin: 0 auto;
        padding: 32px 20px 60px;
      }
      .hero {
        background: linear-gradient(135deg, rgba(44, 110, 73, 0.12), rgba(255, 250, 240, 0.9));
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 28px;
        box-shadow: 0 18px 50px rgba(58, 49, 34, 0.08);
      }
      .eyebrow {
        color: var(--accent);
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      h1, h2, h3 {
        line-height: 1.15;
        margin: 0 0 14px;
      }
      h1 {
        font-size: clamp(2rem, 4vw, 3rem);
        margin-top: 8px;
      }
      .summary {
        font-size: 1.08rem;
        color: var(--text);
        margin: 18px 0 0;
      }
      .meta {
        margin-top: 14px;
        color: var(--muted);
        font-size: 0.95rem;
      }
      .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 24px;
        margin-top: 22px;
        box-shadow: 0 10px 28px rgba(58, 49, 34, 0.06);
      }
      .report-body p, .report-body li {
        font-size: 1rem;
      }
      .report-body ul, .report-body ol {
        padding-left: 1.3rem;
      }
      .report-body pre {
        white-space: pre-wrap;
        background: #f5efdf;
        border-radius: 12px;
        padding: 14px;
        border: 1px solid var(--line);
        overflow-x: auto;
      }
      .evidence-grid {
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .evidence-card {
        margin: 0;
        background: #f9f3e4;
        border: 1px solid var(--line);
        border-radius: 14px;
        overflow: hidden;
      }
      .evidence-card img {
        display: block;
        width: 100%;
        height: auto;
        background: #efe4cf;
      }
      .evidence-card figcaption {
        font-size: 0.95rem;
        font-weight: 600;
        padding: 10px 12px 0;
      }
      .evidence-link {
        margin: 6px 0 0;
        padding: 0 12px 12px;
      }
      .artifact-type, .source-meta {
        color: var(--muted);
      }
      .artifact-path {
        color: var(--muted);
        font-size: 0.9rem;
      }
      .evidence-list {
        list-style: none;
        padding: 0;
        margin: 0;
      }
      .evidence-list li + li {
        margin-top: 12px;
        padding-top: 12px;
        border-top: 1px dashed var(--line);
      }
      a {
        color: var(--accent);
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <div class="eyebrow">Agent Result</div>
        <h1>${escapeHtml(args.title)}</h1>
        <p class="summary">${escapeHtml(args.summary)}</p>
        <p class="meta">Completed ${escapeHtml(new Date(completedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }))} UTC</p>
        ${sourceMeta}
      </section>
      <section class="card">
        <h2>Full Result</h2>
        <div class="report-body">${args.reportHtml}</div>
      </section>
      ${screenshotEvidenceHtml}
      ${evidenceHtml}
    </main>
  </body>
</html>`;
}

function renderSummaryFallback(summary: string, handoffNote: string | null): string {
  const escapedSummary = `<p>${escapeHtml(summary)}</p>`;
  if (!handoffNote) {
    return escapedSummary;
  }

  return `${escapedSummary}<pre>${escapeHtml(String(handoffNote || "").trim())}</pre>`;
}

function renderMarkdownishToHtml(markdown: string): string {
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  const chunks: string[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let orderedItems: string[] = [];
  let codeLines: string[] = [];
  let inCodeBlock = false;

  const flushParagraph = () => {
    if (!paragraph.length) {
      return;
    }

    chunks.push(`<p>${escapeHtml(paragraph.join(" ").replace(/\s+/g, " ").trim())}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length) {
      chunks.push(`<ul>${listItems.map((item) => `<li>${item}</li>`).join("")}</ul>`);
      listItems = [];
    }
    if (orderedItems.length) {
      chunks.push(`<ol>${orderedItems.map((item) => `<li>${item}</li>`).join("")}</ol>`);
      orderedItems = [];
    }
  };

  const flushCode = () => {
    if (!codeLines.length) {
      return;
    }

    chunks.push(`<pre>${escapeHtml(codeLines.join("\n"))}</pre>`);
    codeLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (/^```/.test(line.trim())) {
      flushParagraph();
      flushList();
      if (inCodeBlock) {
        flushCode();
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(rawLine);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = Math.min(3, headingMatch[1].length + 1);
      chunks.push(`<h${level}>${escapeHtml(headingMatch[2])}</h${level}>`);
      continue;
    }

    const bulletMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (bulletMatch) {
      flushParagraph();
      orderedItems = [];
      listItems.push(renderInlineMarkdown(bulletMatch[1]));
      continue;
    }

    const orderedMatch = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (orderedMatch) {
      flushParagraph();
      listItems = [];
      orderedItems.push(renderInlineMarkdown(orderedMatch[1]));
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushCode();

  return chunks.join("\n");
}

function renderInlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function parseMarkdownSections(content: string): Array<{ heading: string; lines: string[] }> {
  const sections: Array<{ heading: string; lines: string[] }> = [{ heading: "", lines: [] }];

  for (const line of String(content || "").replace(/\r/g, "").split("\n")) {
    const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (headingMatch) {
      sections.push({ heading: cleanMarkdownText(headingMatch[1] || ""), lines: [] });
      continue;
    }

    sections[sections.length - 1].lines.push(line);
  }

  return sections;
}

function findSectionParagraph(
  sections: Array<{ heading: string; lines: string[] }>,
  headings: string[]
): string | null {
  const targets = new Set(headings.map((heading) => heading.toLowerCase()));
  for (const section of sections) {
    if (!targets.has(section.heading.toLowerCase())) {
      continue;
    }

    const paragraph = extractFirstParagraph(cleanMarkdownText(section.lines.join("\n")));
    if (paragraph) {
      return paragraph;
    }
  }

  return null;
}

function findSectionBullets(
  sections: Array<{ heading: string; lines: string[] }>,
  headings: string[]
): string[] {
  const targets = new Set(headings.map((heading) => heading.toLowerCase()));
  for (const section of sections) {
    if (!targets.has(section.heading.toLowerCase())) {
      continue;
    }

    const bullets = section.lines
      .map((line) => {
        const match = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/);
        return match ? cleanMarkdownText(match[1] || "") : "";
      })
      .filter(Boolean);

    if (bullets.length) {
      return bullets;
    }
  }

  return [];
}

function extractFirstParagraph(content: string): string | null {
  const paragraphs = String(content || "")
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return paragraphs[0] || null;
}

function cleanMarkdownText(content: string): string {
  return String(content || "")
    .replace(/\r/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~>#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}

function trimToLength(value: string, maxLength: number): string {
  const compact = String(value || "").replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 3).trim()}...`;
}

function resolveDeliveryTokenSecret(): string {
  return String(process.env.JWT_SECRET || DELIVERY_TOKEN_SECRET_FALLBACK).trim();
}

function signDeliveryToken(taskId: string): string {
  return createHmac("sha256", resolveDeliveryTokenSecret())
    .update(`${DELIVERY_TOKEN_PURPOSE}:${taskId}`)
    .digest("base64url");
}

async function upsertDeliveryArtifact(
  rootTaskId: string,
  deliveryLink: DeliveryLink,
  bundle: DeliveryBundle,
  allowedTaskIds: string[]
): Promise<void> {
  const db = getDb();
  const metadata = {
    allowed_task_ids: [...new Set(allowedTaskIds.filter(Boolean))],
    artifact_refs: bundle.artifactRefs,
    delivery_type: DELIVERY_TOKEN_PURPOSE,
    evidence_images: bundle.evidenceImages,
    html: bundle.html,
    path: deliveryLink.path,
    plain_text: bundle.plainText,
    summary: bundle.summary,
    title: bundle.title,
    url: deliveryLink.url,
  };

  const { data: existing, error: existingError } = await db
    .from("artifacts")
    .select("id")
    .eq("task_id", rootTaskId)
    .eq("artifact_type", DELIVERY_ARTIFACT_TYPE)
    .eq("name", DELIVERY_ARTIFACT_NAME)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (existingError) {
    console.error(`Failed to check existing delivery artifact for ${rootTaskId}:`, existingError);
    return;
  }

  if (existing?.id) {
    const { error } = await db
      .from("artifacts")
      .update({
        external_url: deliveryLink.url || deliveryLink.path,
        metadata,
        mime_type: "text/html",
      })
      .eq("id", existing.id);

    if (error) {
      console.error(`Failed to update delivery artifact for ${rootTaskId}:`, error);
    }
    return;
  }

  const { error } = await db.from("artifacts").insert({
    artifact_type: DELIVERY_ARTIFACT_TYPE,
    external_url: deliveryLink.url || deliveryLink.path,
    metadata,
    mime_type: "text/html",
    name: DELIVERY_ARTIFACT_NAME,
    task_id: rootTaskId,
  });

  if (error) {
    console.error(`Failed to insert delivery artifact for ${rootTaskId}:`, error);
  }
}

export const resultDeliveryTestHooks = {
  buildOperatorResultLink,
  extractInlineImageReferences,
  renderMarkdownishToHtml,
  shouldPublishRichResultPage,
  summarizeSourceText,
};
