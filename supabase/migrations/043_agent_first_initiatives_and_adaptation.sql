UPDATE roles
SET
  policy_doc = CASE id
    WHEN 'relay' THEN
      CASE
        WHEN policy_doc ILIKE '%persistent initiatives%' THEN policy_doc
        ELSE policy_doc || E'\n\n## Initiative persistence\n\n- Reuse an existing project when the request clearly continues the same durable initiative.\n- Create a project automatically when execution work starts a new durable initiative with a stable identifier such as a hostname, site, campaign, or customer implementation.\n- Do not make the operator create projects or routine backend organization manually when the system can do it.'
      END
    WHEN 'sage' THEN
      CASE
        WHEN policy_doc ILIKE '%blind retry%' THEN policy_doc
        ELSE policy_doc || E'\n\n## Adaptation rules\n\n- If similar prior tasks failed or stalled, explicitly change the approach instead of recommending a blind retry.\n- When the work is clearly repeatable or the solution required iteration to get right, direct the implementation path to update or create a shared skill.'
      END
    WHEN 'builder' THEN
      CASE
        WHEN policy_doc ILIKE '%material change%' THEN policy_doc
        ELSE policy_doc || E'\n\n## Persistence and evolution\n\n- Reuse existing project context and shared skills when they fit.\n- If the task is a retry or similar work failed before, do not repeat the same approach without a material change.\n- If you discover a better repeatable procedure, update or create a shared skill before you finish.'
      END
    WHEN 'reviewer' THEN
      CASE
        WHEN policy_doc ILIKE '%previously failed approach%' THEN policy_doc
        ELSE policy_doc || E'\n\n## Adaptation checks\n\n- Call out when the implementation repeated a previously failed approach without adapting.'
      END
    WHEN 'architect' THEN
      CASE
        WHEN policy_doc ILIKE '%better task routing%' THEN policy_doc
        ELSE policy_doc || E'\n\n## Evolution guardrail\n\n- Prefer better task routing, project persistence, and shared skills before creating a new persistent agent profile.'
      END
    ELSE policy_doc
  END,
  updated_at = now()
WHERE id IN ('relay', 'sage', 'builder', 'reviewer', 'architect');

UPDATE system_settings
SET
  value = jsonb_build_object(
    'content',
    COALESCE(value->>'content', '') ||
      E'\n\n## Agent-First Autonomy\n\n- Tasks are the primary execution unit.\n- Shared skills are the primary reuse unit.\n- Projects are internal persistent initiative containers for keeping related tasks, artifacts, memories, and skills together over time.\n- If durable work needs that container, create or reuse it yourself instead of pushing that setup back to the human.\n- If similar work failed before, inspect the prior handoff notes and change the approach materially instead of retrying blindly.'
  ),
  updated_at = now()
WHERE key = 'agent_instructions_override'
  AND COALESCE(value->>'content', '') <> ''
  AND COALESCE(value->>'content', '') NOT ILIKE '%Projects are internal persistent initiative containers%';
