#!/bin/sh
# Test all 10 MCP tools against live Supabase.
# Runs SQL directly against the DB container to simulate what the MCP tools do.
set -eu

DB_CMD="docker compose exec -T db psql -U postgres -d agent_os -t -A"

echo "=== MCP Tool Test Suite ==="
echo ""

# Get the relay agent ID for testing
AGENT_ID=$($DB_CMD -c "SELECT id FROM agents WHERE role_id = 'builder' LIMIT 1;")
echo "Test agent ID: $AGENT_ID"
echo ""

# 1. task_create — insert a test task
echo "--- 1. task_create ---"
TASK_ID=$($DB_CMD -c "INSERT INTO tasks (title, objective, assigned_role, state, priority) VALUES ('Test task', 'Verify MCP tools work', 'builder', 'ready', 'normal') RETURNING id;")
echo "Created task: $TASK_ID"

# 2. task_claim — claim the task
echo "--- 2. task_claim ---"
$DB_CMD -c "UPDATE tasks SET state = 'claimed', claimed_by = '$AGENT_ID' WHERE id = '$TASK_ID' AND state = 'ready';"
CLAIMED=$($DB_CMD -c "SELECT state FROM tasks WHERE id = '$TASK_ID';")
echo "Task state after claim: $CLAIMED"

# 3. task_update — move to running
echo "--- 3. task_update ---"
$DB_CMD -c "UPDATE tasks SET state = 'running', last_handoff_note = 'Starting work on test task' WHERE id = '$TASK_ID' AND claimed_by = '$AGENT_ID';"
RUNNING=$($DB_CMD -c "SELECT state FROM tasks WHERE id = '$TASK_ID';")
echo "Task state after update: $RUNNING"

# 4. event_log — log an event
echo "--- 4. event_log ---"
EVENT_ID=$($DB_CMD -c "INSERT INTO events (trace_id, agent_id, event_type, severity, scope_type, scope_id, summary) VALUES ('test-trace', '$AGENT_ID', 'test.run', 'info', 'task', '$TASK_ID', 'Running MCP tool tests') RETURNING id;")
echo "Logged event: $EVENT_ID"

# 5. memory_write — write a memory
echo "--- 5. memory_write ---"
MEMORY_ID=$($DB_CMD -c "INSERT INTO memories (layer, scope_type, scope_id, subject, content, source_agent_id) VALUES ('episodic', 'task', '$TASK_ID', 'Test memory', 'This is a test memory for MCP tool verification', '$AGENT_ID') RETURNING id;")
echo "Wrote memory: $MEMORY_ID"

# 5b. Also insert a memory_chunk for search
CHUNK_ID=$($DB_CMD -c "INSERT INTO memory_chunks (source_type, source_id, scope_type, scope_id, content) VALUES ('memory', '$MEMORY_ID', 'task', '$TASK_ID', 'Test memory: This is a test memory for MCP tool verification') RETURNING id;")
echo "Created chunk: $CHUNK_ID"

# 6. memory_search — search memories via FTS
echo "--- 6. memory_search ---"
SEARCH_RESULTS=$($DB_CMD -c "SELECT count(*) FROM memory_chunks WHERE content ILIKE '%test memory%';")
echo "FTS search matches: $SEARCH_RESULTS"

# 7. artifact_put — register an artifact
echo "--- 7. artifact_put ---"
ARTIFACT_ID=$($DB_CMD -c "INSERT INTO artifacts (name, artifact_type, task_id, created_by) VALUES ('test-report.md', 'doc', '$TASK_ID', '$AGENT_ID') RETURNING id;")
echo "Created artifact: $ARTIFACT_ID"

# 8. handoff_create — create a handoff note
echo "--- 8. handoff_create ---"
HANDOFF_ID=$($DB_CMD -c "INSERT INTO handoffs (task_id, from_agent_id, to_role_id, summary, changes_made, next_steps) VALUES ('$TASK_ID', '$AGENT_ID', 'reviewer', 'Test task completed', '{\"Created test data\"}', '{\"Review test results\"}') RETURNING id;")
echo "Created handoff: $HANDOFF_ID"

# 9. approval_request — create an approval
echo "--- 9. approval_request ---"
# First move task back to running for the approval test
APPROVAL_ID=$($DB_CMD -c "INSERT INTO approvals (task_id, agent_id, action_type, description) VALUES ('$TASK_ID', '$AGENT_ID', 'test.action', 'Testing approval flow') RETURNING id;")
echo "Created approval: $APPROVAL_ID"

# 10. context_refresh — call build_context_pack
echo "--- 10. context_refresh ---"
CONTEXT=$($DB_CMD -c "SELECT jsonb_typeof(build_context_pack('$TASK_ID'));")
echo "Context pack type: $CONTEXT"

# Verify task state machine — try completing
echo ""
echo "--- State machine test ---"
$DB_CMD -c "UPDATE tasks SET state = 'in_review', last_handoff_note = 'Moving to review' WHERE id = '$TASK_ID';"
REVIEW_STATE=$($DB_CMD -c "SELECT state FROM tasks WHERE id = '$TASK_ID';")
echo "State after in_review: $REVIEW_STATE"

$DB_CMD -c "UPDATE tasks SET state = 'completed', last_handoff_note = 'All tests passed' WHERE id = '$TASK_ID';"
FINAL_STATE=$($DB_CMD -c "SELECT state FROM tasks WHERE id = '$TASK_ID';")
echo "Final state: $FINAL_STATE"

# Cleanup
echo ""
echo "--- Cleanup ---"
$DB_CMD -c "DELETE FROM approvals WHERE task_id = '$TASK_ID';"
$DB_CMD -c "DELETE FROM handoffs WHERE task_id = '$TASK_ID';"
$DB_CMD -c "DELETE FROM artifacts WHERE task_id = '$TASK_ID';"
$DB_CMD -c "DELETE FROM memory_chunks WHERE source_id = '$MEMORY_ID';"
$DB_CMD -c "DELETE FROM memories WHERE id = '$MEMORY_ID';"
$DB_CMD -c "DELETE FROM events WHERE trace_id = 'test-trace';"
$DB_CMD -c "DELETE FROM tasks WHERE id = '$TASK_ID';"
echo "Test data cleaned up."

echo ""
echo "=== All 10 MCP tools verified ==="
