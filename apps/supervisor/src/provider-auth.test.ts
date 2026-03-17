import test from "node:test";
import assert from "node:assert/strict";
import { providerAuthTestHooks } from "./provider-auth.js";

test("parses Anthropic auth status metadata from Claude JSON output", () => {
  const snapshot = providerAuthTestHooks.parseAnthropicAuthStatusPayload({
    stdout: JSON.stringify({
      apiProvider: "firstParty",
      authMethod: "claude.ai",
      email: "operator@example.com",
      loggedIn: true,
      orgId: "org-123",
      orgName: "Example Org",
      subscriptionType: "team",
    }),
  });

  assert.deepEqual(snapshot, {
    apiProvider: "firstParty",
    authMethod: "claude.ai",
    email: "operator@example.com",
    loggedIn: true,
    organizationId: "org-123",
    organizationName: "Example Org",
    subscriptionType: "team",
  });
});

test("parses logged-out Anthropic auth status without inventing metadata", () => {
  const snapshot = providerAuthTestHooks.parseAnthropicAuthStatusPayload({
    stdout: JSON.stringify({
      apiProvider: "firstParty",
      authMethod: "none",
      loggedIn: false,
    }),
  });

  assert.deepEqual(snapshot, {
    apiProvider: "firstParty",
    authMethod: "none",
    email: null,
    loggedIn: false,
    organizationId: null,
    organizationName: null,
    subscriptionType: null,
  });
});

test("extracts verification URLs from Claude login output", () => {
  const url = providerAuthTestHooks.extractVerificationUrl(
    "If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&state=abc123"
  );

  assert.equal(
    url,
    "https://claude.ai/oauth/authorize?code=true&state=abc123"
  );
});

test("ignores login output lines without verification URLs", () => {
  const url = providerAuthTestHooks.extractVerificationUrl("Opening browser to sign in...");
  assert.equal(url, null);
});
