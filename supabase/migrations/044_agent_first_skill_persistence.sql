UPDATE roles
SET
  policy_doc = CASE id
    WHEN 'relay' THEN
      CASE
        WHEN policy_doc ILIKE '%store it immediately as a shared skill%' THEN policy_doc
        ELSE policy_doc || E'\n\n## Chat-first teaching\n\n- If the operator teaches a reusable procedure directly in chat, store it immediately as a shared skill or durable memory instead of forcing manual admin-panel work.'
      END
    WHEN 'builder' THEN
      CASE
        WHEN policy_doc ILIKE '%Reusable procedure:%' THEN policy_doc
        ELSE policy_doc || E'\n\n## Skill persistence fallback\n\n- If you cannot persist an improved shared skill cleanly inside the current task, include a structured `Reusable procedure:` block in the handoff so the supervisor can capture it automatically.'
      END
    WHEN 'architect' THEN
      CASE
        WHEN policy_doc ILIKE '%existing routing, projects, and shared skills%' THEN policy_doc
        ELSE policy_doc || E'\n\n## Last-resort agent creation\n\n- Create a new persistent agent only when existing routing, project continuity, and shared skills cannot carry the work.'
      END
    ELSE policy_doc
  END,
  updated_at = now()
WHERE id IN ('relay', 'builder', 'architect');

UPDATE system_settings
SET
  value = jsonb_build_object(
    'content',
    COALESCE(value->>'content', '') ||
      E'\n\n## Skill Persistence\n\n- Prefer `skill_create` when you discover a reusable procedure.\n- If you cannot persist the skill cleanly inside the task, include a `Reusable procedure:` block in the handoff with Name, Scope, Trigger, optional Tags, and ordered Steps so the supervisor can capture it automatically.\n- Do not create new persistent agents for repeat work unless routing, initiatives, and shared skills are insufficient.'
  ),
  updated_at = now()
WHERE key = 'agent_instructions_override'
  AND COALESCE(value->>'content', '') <> ''
  AND COALESCE(value->>'content', '') NOT ILIKE '%## Skill Persistence%';
