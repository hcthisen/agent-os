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
