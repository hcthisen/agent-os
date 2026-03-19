import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { config } from "./config.js";
import { controlPlaneTestHooks } from "./control-plane.js";

test("service_request defaults common service base URLs", () => {
  assert.equal(
    controlPlaneTestHooks.getDefaultServiceBaseUrl("gohighlevel"),
    "https://services.leadconnectorhq.com"
  );
  assert.equal(
    controlPlaneTestHooks.getDefaultServiceBaseUrl("github"),
    "https://api.github.com"
  );
});

test("service_request applies default GoHighLevel API headers", () => {
  assert.deepEqual(controlPlaneTestHooks.getDefaultServiceRequestHeaders("gohighlevel"), {
    Accept: "application/json",
    Version: "2021-07-28",
  });
});

test("service_request applies default auth config for Gemini and ElevenLabs", () => {
  assert.deepEqual(controlPlaneTestHooks.getDefaultServiceRequestAuthDefaults("gemini"), {
    authHeaderName: "x-goog-api-key",
    authMode: "x-api-key",
  });
  assert.deepEqual(
    controlPlaneTestHooks.getDefaultServiceRequestAuthDefaults("elevenlabs"),
    {
      authHeaderName: "xi-api-key",
      authMode: "x-api-key",
    }
  );
});

test("service_request selects labeled token-like credential values by default", () => {
  const selected = controlPlaneTestHooks.selectServiceCredentialValue(
    "pit key: pit-example-token\nlocation id: location-123"
  );

  assert.equal(selected, "pit-example-token");
});

test("service_request can target relative paths under the service base URL", () => {
  const url = controlPlaneTestHooks.buildServiceRequestUrl({
    baseUrl: "https://services.leadconnectorhq.com",
    path: "/contacts/search",
    query: {
      page: 1,
      pageLimit: 1,
    },
  });

  assert.equal(
    url,
    "https://services.leadconnectorhq.com/contacts/search?page=1&pageLimit=1"
  );
});

test("service_request rejects explicit URLs that do not match the service origin", () => {
  assert.throws(() =>
    controlPlaneTestHooks.buildServiceRequestUrl({
      baseUrl: "https://services.leadconnectorhq.com",
      url: "https://evil.example.com/collect",
    })
  );
});

test("service_request builds bearer auth headers from the service credential", () => {
  const headers = controlPlaneTestHooks.buildServiceRequestHeaders({
    authMode: "bearer",
    credential: "pit-example-token",
    headers: {
      Version: "2021-07-28",
    },
  });

  assert.equal(headers.Authorization, "Bearer pit-example-token");
  assert.equal(headers.Version, "2021-07-28");
});

test("service_request can build custom x-api-key auth headers", () => {
  const headers = controlPlaneTestHooks.buildServiceRequestHeaders({
    authHeaderName: "x-goog-api-key",
    authMode: "x-api-key",
    credential: "gemini-token",
  });

  assert.equal(headers["x-goog-api-key"], "gemini-token");
});

test("service_request auto-decodes JSON bodies", () => {
  const parsed = controlPlaneTestHooks.parseServiceResponseBody(
    new TextEncoder().encode(JSON.stringify({ ok: true })),
    "application/json",
    controlPlaneTestHooks.normalizeServiceResponseMode("auto")
  );

  assert.deepEqual(parsed, {
    base64: null,
    isBinary: false,
    json: { ok: true },
    text: null,
  });
});

test("service_request auto-decodes binary bodies as base64", () => {
  const parsed = controlPlaneTestHooks.parseServiceResponseBody(
    Uint8Array.from([0, 255, 10, 20]),
    "audio/mpeg",
    controlPlaneTestHooks.normalizeServiceResponseMode("auto")
  );

  assert.equal(parsed.isBinary, true);
  assert.equal(parsed.json, null);
  assert.equal(parsed.text, null);
  assert.equal(parsed.base64, "AP8KFA==");
});

test("service_request can save binary bodies directly into the task workspace", async () => {
  const previousWorkspacesDir = config.workspacesDir;
  const tempRoot = await mkdtemp(join(tmpdir(), "agent-os-service-request-"));

  try {
    config.workspacesDir = tempRoot;
    const saved = await controlPlaneTestHooks.saveServiceRequestOutputToWorkspace({
      bytes: Uint8Array.from([1, 2, 3, 4]),
      outputPath: "outputs/media/test.bin",
      taskId: "task-123",
    });

    assert.equal(saved.workspace_path, "outputs/media/test.bin");
    assert.equal(saved.size_bytes, 4);
    assert.deepEqual(
      Array.from(await readFile(join(tempRoot, "task-123", "outputs", "media", "test.bin"))),
      [1, 2, 3, 4]
    );
  } finally {
    config.workspacesDir = previousWorkspacesDir;
    await rm(tempRoot, { force: true, recursive: true });
  }
});

test("service_request normalizes workspace output paths", () => {
  assert.equal(
    controlPlaneTestHooks.normalizeWorkspaceOutputPath("\\outputs\\media\\voice.mp3"),
    "outputs/media/voice.mp3"
  );
  assert.equal(
    controlPlaneTestHooks.normalizeWorkspaceOutputPath("/outputs/media/voice.mp3"),
    "outputs/media/voice.mp3"
  );
});

test("service_request is blocked when a configured remote MCP service exists", () => {
  const blocked = controlPlaneTestHooks.shouldBlockServiceRequestForService({
    auth_type: "bearer",
    base_url: null,
    credential: "pit key: pit-example-token\nlocation id: location-123",
    created_at: null,
    display_name: "GoHighLevel",
    error_message: null,
    id: "service-1",
    last_verified: null,
    registered_by: null,
    service_name: "gohighlevel",
    status: "active",
    updated_at: new Date().toISOString(),
  });

  assert.equal(blocked, true);
});
