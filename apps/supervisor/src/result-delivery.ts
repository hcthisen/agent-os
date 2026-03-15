import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { config } from "./config.js";
import { getDb } from "./db.js";

const DELIVERY_ARTIFACT_TYPE = "delivery_page";
const DELIVERY_ARTIFACT_NAME = "operator-result-page";
const DELIVERY_TOKEN_PURPOSE = "operator-result";
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

interface DeliveryBundle {
  artifactRefs: DeliveryArtifactReference[];
  html: string;
  plainText: string;
  summary: string;
  title: string;
}

export async function maybePublishOperatorResultPage(args: {
  deliveryChannel: "admin_chat" | "telegram";
  requestTasks: DeliveryTask[];
  rootTaskId: string;
  rootTaskTitle: string;
  selectedTask: DeliveryTask;
  summary: string;
}): Promise<string | null> {
  const shareUrl = buildOperatorResultUrl(args.rootTaskId);
  if (!shareUrl) {
    return null;
  }

  const artifacts = await loadArtifactsForTasks(args.requestTasks.map((task) => task.id));
  if (!shouldPublishRichResultPage(args.summary, args.selectedTask, artifacts, args.deliveryChannel)) {
    return null;
  }

  const bundle = await buildDeliveryBundle({
    artifacts,
    requestTasks: args.requestTasks,
    rootTaskTitle: args.rootTaskTitle,
    selectedTask: args.selectedTask,
    summary: args.summary,
  });

  await upsertDeliveryArtifact(args.rootTaskId, shareUrl, bundle);
  return shareUrl;
}

function buildOperatorResultUrl(taskId: string): string | null {
  const baseUrl = String(
    process.env.ADMIN_PUBLIC_URL || process.env.SERVICE_URL_ADMIN || ""
  )
    .trim()
    .replace(/\/+$/, "");
  const secret = String(process.env.JWT_SECRET || "").trim();

  if (!baseUrl || !secret || !taskId) {
    return null;
  }

  const token = createHmac("sha256", secret)
    .update(`${DELIVERY_TOKEN_PURPOSE}:${taskId}`)
    .digest("base64url");

  return `${baseUrl}/deliveries/${taskId}/${token}`;
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
  requestTasks: DeliveryTask[];
  rootTaskTitle: string;
  selectedTask: DeliveryTask;
  summary: string;
}): Promise<DeliveryBundle> {
  const primaryArtifact = pickPrimaryArtifact(args.artifacts, args.selectedTask.id);
  const sourceText = await readPrimaryArtifactText(primaryArtifact);
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
  const title = buildDeliveryTitle(args.rootTaskTitle, args.selectedTask);
  const plainText = buildPlainTextDelivery({
    artifactRefs,
    selectedTask: args.selectedTask,
    sourceText,
    summary: derivedSummary,
  });

  return {
    artifactRefs,
    html: buildDeliveryHtmlDocument({
      artifactRefs,
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
  if (![".html", ".markdown", ".md", ".txt"].includes(extension)) {
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

  return trimToLength(lines.filter(Boolean).join("\n"), MAX_SOURCE_CHARS);
}

function buildDeliveryHtmlDocument(args: {
  artifactRefs: DeliveryArtifactReference[];
  primaryArtifact: DeliveryArtifactRow | null;
  reportHtml: string;
  selectedTask: DeliveryTask;
  summary: string;
  title: string;
}): string {
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

async function upsertDeliveryArtifact(
  rootTaskId: string,
  shareUrl: string,
  bundle: DeliveryBundle
): Promise<void> {
  const db = getDb();
  const metadata = {
    artifact_refs: bundle.artifactRefs,
    delivery_type: DELIVERY_TOKEN_PURPOSE,
    html: bundle.html,
    plain_text: bundle.plainText,
    summary: bundle.summary,
    title: bundle.title,
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
        external_url: shareUrl,
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
    external_url: shareUrl,
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
  renderMarkdownishToHtml,
  shouldPublishRichResultPage,
  summarizeSourceText,
};
