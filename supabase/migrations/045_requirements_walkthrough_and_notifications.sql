UPDATE roles
SET
  policy_doc = CASE
    WHEN id = 'relay' AND policy_doc NOT ILIKE '%## Requirements walkthrough%' THEN
      policy_doc || E'\n\n## Requirements walkthrough\n\n- If the operator explicitly asks what else the system needs, answer that directly in the next operator-facing reply with a concrete checklist.\n- List what is required now, what will be needed later, and what is optional but helpful when possible.\n- If nothing else is needed, say that plainly instead of sending only a vague progress acknowledgement.\n- You may still route downstream planning work when useful, but do not hide behind "I will make a plan and get back to you."'
    WHEN id = 'sage' AND policy_doc NOT ILIKE '%## Operator clarification%' THEN
      policy_doc || E'\n\n## Operator clarification\n\n- When a request explicitly asks for missing inputs, tools, accounts, credentials, or decisions, answer those questions concretely before defaulting to deeper planning.\n- Plans for external-service or multi-step work should surface the exact operator prerequisites, not only internal next steps.'
    ELSE policy_doc
  END,
  updated_at = now()
WHERE id IN ('relay', 'sage');

UPDATE system_settings
SET
  value = jsonb_build_object(
    'content',
    COALESCE(value->>'content', '') ||
      E'\n\n## Operator clarity\n\n- When the operator explicitly asks what else is needed, the next reply must contain the concrete missing requirements or a clear statement that nothing else is needed.\n- Do not reply with only a vague planning acknowledgement in those cases.'
  ),
  updated_at = now()
WHERE key = 'agent_instructions_override'
  AND COALESCE(value->>'content', '') <> ''
  AND COALESCE(value->>'content', '') NOT ILIKE '%## Operator clarity%';
