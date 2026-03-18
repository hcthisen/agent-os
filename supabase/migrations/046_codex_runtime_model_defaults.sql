INSERT INTO system_settings (key, value)
VALUES (
  'runtime_provider',
  jsonb_build_object(
    'activeProvider', 'anthropic',
    'openaiModelMap', jsonb_build_object(
      'haiku', 'gpt-5.4-nano',
      'sonnet', 'gpt-5.4-mini',
      'opus', 'gpt-5.4'
    ),
    'openaiRoleConfig', jsonb_build_object(
      'relay', jsonb_build_object('model', 'gpt-5.4-nano', 'effort', 'low'),
      'sage', jsonb_build_object('model', 'gpt-5.4', 'effort', 'xhigh'),
      'builder', jsonb_build_object('model', 'gpt-5.4', 'effort', 'high'),
      'reviewer', jsonb_build_object('model', 'gpt-5.4-mini', 'effort', 'high'),
      'architect', jsonb_build_object('model', 'gpt-5.4', 'effort', 'high'),
      'sentinel', jsonb_build_object('model', 'gpt-5.4-nano', 'effort', 'medium')
    )
  )
)
ON CONFLICT (key) DO NOTHING;

UPDATE system_settings
SET
  value = jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                COALESCE(value, '{}'::jsonb),
                '{openaiModelMap,haiku}',
                to_jsonb('gpt-5.4-nano'::text),
                true
              ),
              '{openaiModelMap,sonnet}',
              to_jsonb('gpt-5.4-mini'::text),
              true
            ),
            '{openaiModelMap,opus}',
            to_jsonb('gpt-5.4'::text),
            true
          ),
          '{openaiRoleConfig,relay}',
          jsonb_build_object('model', 'gpt-5.4-nano', 'effort', 'low'),
          true
        ),
        '{openaiRoleConfig,sentinel}',
        jsonb_build_object('model', 'gpt-5.4-nano', 'effort', 'medium'),
        true
      ),
      '{openaiRoleConfig,reviewer}',
      jsonb_build_object('model', 'gpt-5.4-mini', 'effort', 'high'),
      true
    ),
    '{openaiRoleConfig}',
    COALESCE(value->'openaiRoleConfig', '{}'::jsonb) || jsonb_build_object(
      'architect', jsonb_build_object('model', 'gpt-5.4', 'effort', 'high'),
      'builder', jsonb_build_object('model', 'gpt-5.4', 'effort', 'high'),
      'sage', jsonb_build_object('model', 'gpt-5.4', 'effort', 'xhigh')
    ),
    true
  ),
  updated_at = now()
WHERE key = 'runtime_provider';
