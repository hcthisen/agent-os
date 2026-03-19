import test from "node:test";
import assert from "node:assert/strict";

import { serviceRegistryTestHooks } from "./service-registry.js";

test("extractNonSecretCredentialFields keeps scoped identifiers and removes secrets", () => {
  const fields = serviceRegistryTestHooks.extractNonSecretCredentialFields(
    [
      "pit key: pit-123",
      "location id: e5bbkTW6urr3zew52cxA",
      "workspace id: ws_123",
      "base url: https://services.leadconnectorhq.com",
      "api key: secret-value",
    ].join("\n")
  );

  assert.deepEqual(fields, {
    "base url": "https://services.leadconnectorhq.com",
    "location id": "e5bbkTW6urr3zew52cxA",
    "workspace id": "ws_123",
  });
});

test("toSanitizedServiceConnectionHint exposes service metadata without credentials", () => {
  const hint = serviceRegistryTestHooks.toSanitizedServiceConnectionHint({
    auth_type: "bearer",
    base_url: "https://services.leadconnectorhq.com",
    credential: "pit key: pit-123\nlocation id: e5bbkTW6urr3zew52cxA",
    error_message: null,
    id: "svc-1",
    service_name: "gohighlevel",
    status: "active",
    updated_at: "2026-03-19T00:00:00Z",
  });

  assert.deepEqual(hint, {
    base_url: "https://services.leadconnectorhq.com",
    display_name: "gohighlevel",
    non_secret_fields: {
      "location id": "e5bbkTW6urr3zew52cxA",
    },
    service_name: "gohighlevel",
    status: "active",
    usage_hints: serviceRegistryTestHooks.DEFAULT_SERVICE_USAGE_HINTS.gohighlevel,
  });
});

test("toSanitizedServiceConnectionHint fills default base URLs and usage hints for github", () => {
  const hint = serviceRegistryTestHooks.toSanitizedServiceConnectionHint({
    auth_type: "api_key",
    base_url: null,
    credential: "token: ghp_test_value",
    error_message: null,
    id: "svc-2",
    service_name: "github",
    status: "active",
    updated_at: "2026-03-19T00:00:00Z",
  });

  assert.deepEqual(hint, {
    base_url: serviceRegistryTestHooks.DEFAULT_SERVICE_BASE_URL_HINTS.github,
    display_name: "github",
    non_secret_fields: {},
    service_name: "github",
    status: "active",
    usage_hints: serviceRegistryTestHooks.DEFAULT_SERVICE_USAGE_HINTS.github,
  });
});
