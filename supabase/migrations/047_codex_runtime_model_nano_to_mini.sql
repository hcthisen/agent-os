UPDATE system_settings
SET
  value = jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(value, '{}'::jsonb),
          '{openaiModelMap,haiku}',
          to_jsonb('gpt-5.4-mini'::text),
          true
        ),
        '{openaiRoleConfig,relay}',
        jsonb_build_object('model', 'gpt-5.4-mini', 'effort', 'low'),
        true
      ),
      '{openaiRoleConfig,sentinel}',
      jsonb_build_object('model', 'gpt-5.4-mini', 'effort', 'medium'),
      true
    ),
    '{openaiRoleConfig,reviewer}',
    jsonb_build_object('model', 'gpt-5.4-mini', 'effort', 'high'),
    true
  ),
  updated_at = now()
WHERE key = 'runtime_provider';

UPDATE roles
SET model = 'gpt-5.4-mini'
WHERE lower(COALESCE(model, '')) = 'gpt-5.4-nano';

UPDATE agents
SET
  config = jsonb_set(
    COALESCE(config, '{}'::jsonb),
    '{model}',
    to_jsonb('gpt-5.4-mini'::text),
    true
  ),
  updated_at = now()
WHERE lower(COALESCE(config->>'model', '')) = 'gpt-5.4-nano';
