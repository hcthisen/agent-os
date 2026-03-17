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

test("extracts Claude auth code from callback URL", () => {
  const code = providerAuthTestHooks.extractAnthropicAuthCode(
    "https://platform.claude.com/oauth/code/callback?code=abc123&state=state456"
  );

  assert.equal(code, "abc123#state456");
});

test("accepts a pasted Claude code#state value directly", () => {
  const code = providerAuthTestHooks.extractAnthropicAuthCode("abc123#state456");
  assert.equal(code, "abc123#state456");
});

test("parses Claude callback payload into code and state", () => {
  const payload = providerAuthTestHooks.parseAnthropicAuthCallback(
    "https://platform.claude.com/oauth/code/callback?code=abc123&state=state456"
  );

  assert.deepEqual(payload, {
    code: "abc123",
    state: "state456",
  });
});

test("builds a Claude manual OAuth URL with the expected redirect and state", () => {
  const url = new URL(
    providerAuthTestHooks.buildAnthropicVerificationUrl("verifier123", "state456")
  );

  assert.equal(url.origin + url.pathname, "https://claude.ai/oauth/authorize");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://platform.claude.com/oauth/code/callback"
  );
  assert.equal(url.searchParams.get("state"), "state456");
  assert.equal(url.searchParams.get("client_id"), "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("scope") || "", /user:sessions:claude_code/);
});

test("ignores login output lines without verification URLs", () => {
  const url = providerAuthTestHooks.extractVerificationUrl("Opening browser to sign in...");
  assert.equal(url, null);
});
