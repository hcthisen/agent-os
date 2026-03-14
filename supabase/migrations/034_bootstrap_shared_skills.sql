WITH seed_skills AS (
  SELECT *
  FROM (
    VALUES
      (
        'skill:agent-browser-ui-verification',
        'Agent Browser UI Verification',
        'Use the preinstalled agent-browser workflow for screenshots, UI inspection, login flows, and browser-driven QA.',
        'When a task requires screenshots, visual QA, browser interaction, auth-flow verification, or DOM inspection in a real browser.',
        '[
          {"order": 1, "instruction": "Use the preinstalled agent-browser workflow instead of installing Playwright, Chromium, or another browser stack in the task workspace.", "tool_hint": "agent-browser", "required": true},
          {"order": 2, "instruction": "Open the target page, capture a snapshot tree, and interact through stable element refs when possible.", "tool_hint": "agent-browser", "required": true},
          {"order": 3, "instruction": "Collect screenshots plus console and page-error evidence for the final report.", "tool_hint": "agent-browser", "required": true},
          {"order": 4, "instruction": "Close the opened tab or browser session when the browser task is complete.", "tool_hint": "agent-browser", "required": true}
        ]'::jsonb,
        'Skill: Agent Browser UI Verification
Slug: agent-browser-ui-verification
Description: Use the preinstalled agent-browser workflow for screenshots, UI inspection, login flows, and browser-driven QA.
Trigger: When a task requires screenshots, visual QA, browser interaction, auth-flow verification, or DOM inspection in a real browser.
Steps: 1. Use the preinstalled agent-browser workflow instead of installing Playwright, Chromium, or another browser stack in the task workspace. 2. Open the target page, capture a snapshot tree, and interact through stable element refs when possible. 3. Collect screenshots plus console and page-error evidence for the final report. 4. Close the opened tab or browser session when the browser task is complete.
Tags: skill, browser, ui, qa',
        ARRAY['skill', 'browser', 'ui', 'qa']::text[]
      ),
      (
        'skill:live-vps-validation',
        'Live VPS Validation',
        'Validate runtime and deployment changes on the VPS with direct health checks, selective browser checks, and cleanup of test artifacts.',
        'When a change affects runtime behavior, deployment, credentials, the admin control plane, or live task execution and needs end-to-end validation.',
        '[
          {"order": 1, "instruction": "Deploy only the affected services or migrations, then confirm container and health endpoint status before deeper testing.", "tool_hint": "docker", "required": true},
          {"order": 2, "instruction": "Prefer direct health checks, task data inspection, and targeted browser validation over repeated chat-loop testing.", "tool_hint": "shell", "required": true},
          {"order": 3, "instruction": "Avoid unnecessary Telegram noise and repeated operator-facing messages during verification.", "tool_hint": null, "required": true},
          {"order": 4, "instruction": "Remove any test tasks, test skills, test projects, and temporary artifacts created during validation before closing the work.", "tool_hint": "admin-api", "required": true}
        ]'::jsonb,
        'Skill: Live VPS Validation
Slug: live-vps-validation
Description: Validate runtime and deployment changes on the VPS with direct health checks, selective browser checks, and cleanup of test artifacts.
Trigger: When a change affects runtime behavior, deployment, credentials, the admin control plane, or live task execution and needs end-to-end validation.
Steps: 1. Deploy only the affected services or migrations, then confirm container and health endpoint status before deeper testing. 2. Prefer direct health checks, task data inspection, and targeted browser validation over repeated chat-loop testing. 3. Avoid unnecessary Telegram noise and repeated operator-facing messages during verification. 4. Remove any test tasks, test skills, test projects, and temporary artifacts created during validation before closing the work.
Tags: skill, vps, validation, operations',
        ARRAY['skill', 'vps', 'validation', 'operations']::text[]
      ),
      (
        'skill:shared-skill-authoring',
        'Shared Skill Authoring',
        'Convert repeatable operator instructions into scoped shared skills with a clear trigger, ordered steps, and the right scope.',
        'When the operator teaches a reusable procedure, a recurring rule, or a multi-step workflow that other agents should be able to follow later.',
        '[
          {"order": 1, "instruction": "Decide whether the instruction is better stored as a shared skill or as semantic memory; use a skill for repeatable procedures.", "tool_hint": "memory", "required": true},
          {"order": 2, "instruction": "Choose the narrowest scope that still matches the intent: task, project, role, or company.", "tool_hint": null, "required": true},
          {"order": 3, "instruction": "Rewrite the procedure into a concise trigger statement plus ordered steps with tool hints only when they add signal.", "tool_hint": "skill_create", "required": true},
          {"order": 4, "instruction": "Save the skill and confirm back exactly what was stored so the operator can correct it immediately if needed.", "tool_hint": "skill_create", "required": true}
        ]'::jsonb,
        'Skill: Shared Skill Authoring
Slug: shared-skill-authoring
Description: Convert repeatable operator instructions into scoped shared skills with a clear trigger, ordered steps, and the right scope.
Trigger: When the operator teaches a reusable procedure, a recurring rule, or a multi-step workflow that other agents should be able to follow later.
Steps: 1. Decide whether the instruction is better stored as a shared skill or as semantic memory; use a skill for repeatable procedures. 2. Choose the narrowest scope that still matches the intent: task, project, role, or company. 3. Rewrite the procedure into a concise trigger statement plus ordered steps with tool hints only when they add signal. 4. Save the skill and confirm back exactly what was stored so the operator can correct it immediately if needed.
Tags: skill, training, memory, workflow',
        ARRAY['skill', 'training', 'memory', 'workflow']::text[]
      )
  ) AS seeded(subject, display_name, description, trigger_when, steps_json, chunk_content, tags)
),
inserted_skills AS (
  INSERT INTO memories (
    layer,
    scope_type,
    scope_id,
    subject,
    content,
    tags,
    source_agent_id,
    confidence,
    is_active
  )
  SELECT
    'procedural',
    'company',
    'system',
    seed.subject,
    jsonb_build_object(
      'display_name', seed.display_name,
      'description', seed.description,
      'trigger_when', seed.trigger_when,
      'steps', seed.steps_json,
      'input_schema', jsonb_build_object(),
      'output_schema', jsonb_build_object(),
      'required_services', jsonb_build_array(),
      'version', 1,
      'last_used_at', NULL,
      'use_count', 0
    )::text,
    seed.tags,
    NULL,
    1.0,
    true
  FROM seed_skills seed
  WHERE NOT EXISTS (
    SELECT 1
    FROM memories existing
    WHERE existing.layer = 'procedural'
      AND existing.scope_type = 'company'
      AND existing.scope_id = 'system'
      AND existing.subject = seed.subject
      AND existing.is_active = true
      AND existing.tags @> ARRAY['skill']::text[]
  )
  RETURNING id, scope_type, scope_id, subject
)
INSERT INTO memory_chunks (
  source_type,
  source_id,
  scope_type,
  scope_id,
  content
)
SELECT
  'memory',
  inserted.id,
  inserted.scope_type,
  inserted.scope_id,
  seed.chunk_content
FROM inserted_skills inserted
JOIN seed_skills seed
  ON seed.subject = inserted.subject;
