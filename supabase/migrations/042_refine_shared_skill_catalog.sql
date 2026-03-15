CREATE TEMP TABLE _desired_shared_skills (
  subject text PRIMARY KEY,
  display_name text NOT NULL,
  description text NOT NULL,
  trigger_when text NOT NULL,
  steps_json jsonb NOT NULL,
  chunk_content text NOT NULL,
  tags text[] NOT NULL
);

INSERT INTO _desired_shared_skills (
  subject,
  display_name,
  description,
  trigger_when,
  steps_json,
  chunk_content,
  tags
)
VALUES
  (
    'skill:agent-browser',
    'Agent Browser',
    'Use the preinstalled agent-browser workflow whenever a task needs a real browser session.',
    'When a task needs to open, navigate, log into, inspect, scrape, submit, or otherwise operate a website in a real browser.',
    '[
      {"order": 1, "instruction": "Use the preinstalled agent-browser workflow instead of installing Playwright, Chromium, Selenium, or another browser stack in the task workspace.", "tool_hint": "agent-browser", "required": true},
      {"order": 2, "instruction": "Open the target page or session and perform the required browser actions through agent-browser rather than ad hoc shell tooling.", "tool_hint": "agent-browser", "required": true},
      {"order": 3, "instruction": "Capture only the evidence needed for the task, such as snapshots, extracted page state, screenshots, downloads, or console output.", "tool_hint": "agent-browser", "required": true},
      {"order": 4, "instruction": "Close the opened tab or browser session when the browser work is complete.", "tool_hint": "agent-browser", "required": true}
    ]'::jsonb,
    'Skill: Agent Browser
Slug: agent-browser
Description: Use the preinstalled agent-browser workflow whenever a task needs a real browser session.
Trigger: When a task needs to open, navigate, log into, inspect, scrape, submit, or otherwise operate a website in a real browser.
Steps: 1. Use the preinstalled agent-browser workflow instead of installing Playwright, Chromium, Selenium, or another browser stack in the task workspace. 2. Open the target page or session and perform the required browser actions through agent-browser rather than ad hoc shell tooling. 3. Capture only the evidence needed for the task, such as snapshots, extracted page state, screenshots, downloads, or console output. 4. Close the opened tab or browser session when the browser work is complete.
Tags: skill, browser, automation, web',
    ARRAY['skill', 'browser', 'automation', 'web']::text[]
  ),
  (
    'skill:agent-browser-ui-verification',
    'UI Verification with Agent Browser',
    'Use Agent Browser for browser-based UI verification, screenshots, responsive checks, and regression evidence.',
    'When a task needs UI validation, screenshots, visual comparison, responsive browser QA, or DOM/console evidence after a change.',
    '[
      {"order": 1, "instruction": "Use the Agent Browser skill as the base browser workflow; do not install another browser runtime in the workspace.", "tool_hint": "agent-browser", "required": true},
      {"order": 2, "instruction": "Check the changed page in the relevant viewport(s), capture a snapshot tree, and interact through stable element refs when possible.", "tool_hint": "agent-browser", "required": true},
      {"order": 3, "instruction": "Collect screenshots plus console, page-error, and DOM evidence that proves the UI is correct or shows the regression clearly.", "tool_hint": "agent-browser", "required": true},
      {"order": 4, "instruction": "When the task calls for QA rather than implementation, report findings only and do not claim site changes unless this task actually made them.", "tool_hint": null, "required": true}
    ]'::jsonb,
    'Skill: UI Verification with Agent Browser
Slug: agent-browser-ui-verification
Description: Use Agent Browser for browser-based UI verification, screenshots, responsive checks, and regression evidence.
Trigger: When a task needs UI validation, screenshots, visual comparison, responsive browser QA, or DOM/console evidence after a change.
Steps: 1. Use the Agent Browser skill as the base browser workflow; do not install another browser runtime in the workspace. 2. Check the changed page in the relevant viewport(s), capture a snapshot tree, and interact through stable element refs when possible. 3. Collect screenshots plus console, page-error, and DOM evidence that proves the UI is correct or shows the regression clearly. 4. When the task calls for QA rather than implementation, report findings only and do not claim site changes unless this task actually made them.
Tags: skill, browser, ui, qa, verification',
    ARRAY['skill', 'browser', 'ui', 'qa', 'verification']::text[]
  ),
  (
    'skill:live-vps-validation',
    'Live VPS Validation',
    'Validate runtime and deployment changes on the VPS with direct health checks, selective browser checks, and cleanup of temporary validation artifacts.',
    'When a change affects runtime behavior, deployment, credentials, the admin control plane, or live task execution and needs end-to-end validation.',
    '[
      {"order": 1, "instruction": "Deploy only the affected services or migrations, then confirm container and health endpoint status before deeper testing.", "tool_hint": "docker", "required": true},
      {"order": 2, "instruction": "Prefer direct health checks, task data inspection, and targeted browser validation over repeated chat-loop testing.", "tool_hint": "shell", "required": true},
      {"order": 3, "instruction": "Avoid unnecessary Telegram noise and repeated operator-facing messages during verification.", "tool_hint": null, "required": true},
      {"order": 4, "instruction": "Remove any test tasks, test skills, test projects, and temporary artifacts created during validation before closing the work.", "tool_hint": "admin-api", "required": true}
    ]'::jsonb,
    'Skill: Live VPS Validation
Slug: live-vps-validation
Description: Validate runtime and deployment changes on the VPS with direct health checks, selective browser checks, and cleanup of temporary validation artifacts.
Trigger: When a change affects runtime behavior, deployment, credentials, the admin control plane, or live task execution and needs end-to-end validation.
Steps: 1. Deploy only the affected services or migrations, then confirm container and health endpoint status before deeper testing. 2. Prefer direct health checks, task data inspection, and targeted browser validation over repeated chat-loop testing. 3. Avoid unnecessary Telegram noise and repeated operator-facing messages during verification. 4. Remove any test tasks, test skills, test projects, and temporary artifacts created during validation before closing the work.
Tags: skill, vps, validation, operations',
    ARRAY['skill', 'vps', 'validation', 'operations']::text[]
  ),
  (
    'skill:shared-skill-authoring',
    'Shared Skill Authoring',
    'Convert proven repeatable work into scoped shared skills with a clear trigger, ordered steps, and the right reuse boundary.',
    'When work is scheduled to recur, the operator repeats the same request, a task required difficult iteration to get right, or a reusable multi-step workflow should be preserved for future runs.',
    '[
      {"order": 1, "instruction": "Use a shared skill for repeatable procedures and proven workflows; use semantic memory for durable facts, preferences, and one-line rules.", "tool_hint": "memory", "required": true},
      {"order": 2, "instruction": "Create or update a skill when the work will recur through a schedule, when the operator asks for the same kind of result again, or when a hard task required retries or iteration before you found the successful procedure.", "tool_hint": null, "required": true},
      {"order": 3, "instruction": "Capture the successful workflow as a trigger plus ordered steps, including research, preparation, execution, and verification stages when those stages are part of getting the result right.", "tool_hint": "skill_create", "required": true},
      {"order": 4, "instruction": "Choose the narrowest scope that still fits the reuse pattern: task, project, role, or company.", "tool_hint": null, "required": true},
      {"order": 5, "instruction": "Save the skill and confirm back exactly what was stored so the operator can correct it immediately if needed.", "tool_hint": "skill_create", "required": true}
    ]'::jsonb,
    'Skill: Shared Skill Authoring
Slug: shared-skill-authoring
Description: Convert proven repeatable work into scoped shared skills with a clear trigger, ordered steps, and the right reuse boundary.
Trigger: When work is scheduled to recur, the operator repeats the same request, a task required difficult iteration to get right, or a reusable multi-step workflow should be preserved for future runs.
Steps: 1. Use a shared skill for repeatable procedures and proven workflows; use semantic memory for durable facts, preferences, and one-line rules. 2. Create or update a skill when the work will recur through a schedule, when the operator asks for the same kind of result again, or when a hard task required retries or iteration before you found the successful procedure. 3. Capture the successful workflow as a trigger plus ordered steps, including research, preparation, execution, and verification stages when those stages are part of getting the result right. 4. Choose the narrowest scope that still fits the reuse pattern: task, project, role, or company. 5. Save the skill and confirm back exactly what was stored so the operator can correct it immediately if needed.
Tags: skill, training, memory, workflow',
    ARRAY['skill', 'training', 'memory', 'workflow']::text[]
  );

CREATE TEMP TABLE _existing_active_skill_versions AS
SELECT DISTINCT ON (m.subject)
  m.id,
  m.subject,
  m.content::jsonb AS payload
FROM public.memories m
WHERE m.layer = 'procedural'
  AND m.scope_type = 'company'
  AND m.scope_id = 'system'
  AND m.is_active = true
  AND m.tags @> ARRAY['skill']::text[]
  AND m.subject IN (SELECT subject FROM _desired_shared_skills)
ORDER BY m.subject, m.updated_at DESC, m.created_at DESC, m.id DESC;

INSERT INTO public.memories (
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
  d.subject,
  jsonb_build_object(
    'display_name', d.display_name,
    'description', d.description,
    'trigger_when', d.trigger_when,
    'steps', d.steps_json,
    'input_schema', jsonb_build_object(),
    'output_schema', jsonb_build_object(),
    'required_services', jsonb_build_array(),
    'version', COALESCE(((e.payload ->> 'version'))::int, 0) + 1,
    'last_used_at', e.payload ->> 'last_used_at',
    'use_count', COALESCE(((e.payload ->> 'use_count'))::int, 0)
  )::text,
  d.tags,
  NULL,
  1.0,
  true
FROM _desired_shared_skills d
LEFT JOIN _existing_active_skill_versions e
  ON e.subject = d.subject;

UPDATE public.memories old
SET
  is_active = false,
  superseded_by = newest.id
FROM (
  SELECT DISTINCT ON (m.subject)
    m.id,
    m.subject
  FROM public.memories m
  WHERE m.layer = 'procedural'
    AND m.scope_type = 'company'
    AND m.scope_id = 'system'
    AND m.is_active = true
    AND m.tags @> ARRAY['skill']::text[]
    AND m.subject IN (SELECT subject FROM _desired_shared_skills)
  ORDER BY m.subject, m.created_at DESC, m.updated_at DESC, m.id DESC
) newest
WHERE old.layer = 'procedural'
  AND old.scope_type = 'company'
  AND old.scope_id = 'system'
  AND old.is_active = true
  AND old.tags @> ARRAY['skill']::text[]
  AND old.subject = newest.subject
  AND old.id <> newest.id;

INSERT INTO public.memory_chunks (
  source_type,
  source_id,
  scope_type,
  scope_id,
  content
)
SELECT
  'memory',
  newest.id,
  'company',
  'system',
  desired.chunk_content
FROM (
  SELECT DISTINCT ON (m.subject)
    m.id,
    m.subject
  FROM public.memories m
  WHERE m.layer = 'procedural'
    AND m.scope_type = 'company'
    AND m.scope_id = 'system'
    AND m.is_active = true
    AND m.tags @> ARRAY['skill']::text[]
    AND m.subject IN (SELECT subject FROM _desired_shared_skills)
  ORDER BY m.subject, m.created_at DESC, m.updated_at DESC, m.id DESC
) newest
JOIN _desired_shared_skills desired
  ON desired.subject = newest.subject;

UPDATE public.memories
SET is_active = false
WHERE layer = 'procedural'
  AND scope_type = 'company'
  AND scope_id = 'system'
  AND subject = 'skill:relay-live-objective-skill'
  AND is_active = true;

DROP TABLE _existing_active_skill_versions;
DROP TABLE _desired_shared_skills;
