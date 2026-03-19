import test from "node:test";
import assert from "node:assert/strict";
import { remoteMcpTestHooks } from "./remote-mcp.js";

test("builds a GoHighLevel remote MCP config from minimal PIT credentials", () => {
  const resolved = remoteMcpTestHooks.buildGoHighLevelRemoteMcpConfig({
    auth_type: "bearer",
    base_url: null,
    credential: ["pit key: pit-123", "location id: loc-456"].join("\n"),
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

  assert.ok(resolved);
  assert.equal(
    resolved?.server.url,
    "https://services.leadconnectorhq.com/mcp/"
  );
  assert.equal(
    resolved?.server.bearerTokenEnvVar,
    "AGENT_OS_REMOTE_MCP_GOHIGHLEVEL_TOKEN"
  );
  assert.deepEqual(resolved?.server.envHttpHeaders, {
    locationId: "AGENT_OS_REMOTE_MCP_GOHIGHLEVEL_LOCATION_ID",
  });
  assert.equal(resolved?.env.AGENT_OS_REMOTE_MCP_GOHIGHLEVEL_TOKEN, "pit-123");
  assert.equal(
    resolved?.env.AGENT_OS_REMOTE_MCP_GOHIGHLEVEL_LOCATION_ID,
    "loc-456"
  );
});

test("skips GoHighLevel remote MCP config when the location id is missing", () => {
  const resolved = remoteMcpTestHooks.buildGoHighLevelRemoteMcpConfig({
    auth_type: "bearer",
    base_url: null,
    credential: "pit key: pit-123",
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

  assert.equal(resolved, null);
});

test("reports GoHighLevel as a configured remote MCP service when PIT and location are present", () => {
  const configured = remoteMcpTestHooks.hasConfiguredRemoteMcpServer({
    auth_type: "bearer",
    base_url: null,
    credential: ["pit key: pit-123", "location id: loc-456"].join("\n"),
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

  assert.equal(configured, true);
});
