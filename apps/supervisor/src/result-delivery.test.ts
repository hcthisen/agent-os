import assert from "node:assert/strict";
import test from "node:test";
import { resultDeliveryTestHooks } from "./result-delivery.js";

test("rich result delivery is enabled for report-style tasks with artifacts", () => {
  const shouldPublish = resultDeliveryTestHooks.shouldPublishRichResultPage(
    "Done. Review complete. Main findings: CTA is too low and the offer is undersold.",
    {
      assigned_role: "builder",
      completed_at: "2026-03-15T18:15:16.000Z",
      id: "task-1",
      last_handoff_note: null,
      objective: "Review the public site and report what to improve.",
      title: "Review scalebytech.com",
      updated_at: "2026-03-15T18:15:16.000Z",
    },
    [
      {
        artifact_type: "report",
        created_at: "2026-03-15T18:15:16.000Z",
        external_url: null,
        id: "artifact-1",
        metadata: {},
        mime_type: "text/markdown",
        name: "recommendations",
        storage_path: "artifacts/recommendations.md",
        task_id: "task-1",
      },
    ],
    "telegram"
  );

  assert.equal(shouldPublish, true);
});

test("markdownish delivery rendering keeps headings and lists", () => {
  const html = resultDeliveryTestHooks.renderMarkdownishToHtml(`# Title

## Recommendations
- Move the CTA above the fold
- Explain the offer clearly
`);

  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /<h3>Recommendations<\/h3>/);
  assert.match(html, /<ul>/);
  assert.match(html, /Move the CTA above the fold/);
});

test("source summary extraction prefers summary and recommendations", () => {
  const summary = resultDeliveryTestHooks.summarizeSourceText(`# Executive Summary

The homepage points to the community, but it does not explain the offer clearly enough.

## Recommendations
- Rewrite the hero around the Skool offer
- Raise the CTA on mobile
`);

  assert.match(String(summary), /does not explain the offer clearly enough/i);
  assert.match(String(summary), /Rewrite the hero around the Skool offer/i);
});

test("result delivery builds a signed relative path without requiring public admin url", () => {
  const previousJwtSecret = process.env.JWT_SECRET;
  const previousAdminUrl = process.env.ADMIN_PUBLIC_URL;
  const previousServiceAdminUrl = process.env.SERVICE_URL_ADMIN;
  delete process.env.ADMIN_PUBLIC_URL;
  delete process.env.SERVICE_URL_ADMIN;
  delete process.env.JWT_SECRET;

  try {
    const link = resultDeliveryTestHooks.buildOperatorResultLink(
      "123e4567-e89b-12d3-a456-426614174000"
    );

    assert.ok(link);
    assert.match(String(link?.path), /^\/deliveries\/123e4567-e89b-12d3-a456-426614174000\//);
    assert.equal(link?.url, null);
  } finally {
    process.env.JWT_SECRET = previousJwtSecret;
    process.env.ADMIN_PUBLIC_URL = previousAdminUrl;
    process.env.SERVICE_URL_ADMIN = previousServiceAdminUrl;
  }
});

test("inline image references are extracted from markdown report content", () => {
  const references = resultDeliveryTestHooks.extractInlineImageReferences(`# Evidence

![Homepage screenshot](evidence/homepage.png)
- Competitor proof: [mobile CTA](artifacts/competitors/mobile-cta.webp)
`);

  assert.equal(references.length, 2);
  assert.equal(references[0]?.path, "evidence/homepage.png");
  assert.equal(references[1]?.path, "artifacts/competitors/mobile-cta.webp");
});

test("rich result delivery is enabled for long handoffs with dry-run examples even without artifacts", () => {
  const shouldPublish = resultDeliveryTestHooks.shouldPublishRichResultPage(
    "Done. Set up recurring owner brief schedule and dry-run format is complete.",
    {
      assigned_role: "architect",
      completed_at: "2026-03-18T22:40:22.000Z",
      id: "task-2",
      last_handoff_note: [
        "Stored the shared skill and configured the recurring schedule.",
        "",
        "Dry-run example:",
        "```text",
        "What changed last week",
        "- The recurring schedule is enabled.",
        "```",
      ].join("\n"),
      objective: "Set up recurring owner brief schedule and dry-run format.",
      title: "Set up recurring owner brief schedule and dry-run format",
      updated_at: "2026-03-18T22:40:22.000Z",
    },
    [],
    "admin_chat"
  );

  assert.equal(shouldPublish, true);
});
