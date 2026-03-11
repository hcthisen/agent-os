INSERT INTO system_settings (key, value)
VALUES (
  'runtime_provider',
  jsonb_build_object(
    'activeProvider', 'anthropic',
    'openaiModelMap', jsonb_build_object(
      'opus', 'gpt-5.4',
      'sonnet', 'gpt-5.4',
      'haiku', 'gpt-5.4'
    ),
    'openaiRoleConfig', jsonb_build_object(
      'relay', jsonb_build_object('model', 'gpt-5.4', 'effort', 'low'),
      'sage', jsonb_build_object('model', 'gpt-5.4', 'effort', 'xhigh'),
      'builder', jsonb_build_object('model', 'gpt-5.4', 'effort', 'high'),
      'reviewer', jsonb_build_object('model', 'gpt-5.4', 'effort', 'high'),
      'architect', jsonb_build_object('model', 'gpt-5.4', 'effort', 'high'),
      'sentinel', jsonb_build_object('model', 'gpt-5.3-codex', 'effort', 'medium')
    )
  )
)
ON CONFLICT (key) DO NOTHING;

UPDATE system_settings
SET
  value = jsonb_set(
    jsonb_set(
      COALESCE(value, '{}'::jsonb),
      '{openaiModelMap}',
      COALESCE(value->'openaiModelMap', '{}'::jsonb) || jsonb_build_object(
        'opus', 'gpt-5.4',
        'sonnet', 'gpt-5.4',
        'haiku', 'gpt-5.4'
      ),
      true
    ),
    '{openaiRoleConfig}',
    COALESCE(value->'openaiRoleConfig', '{}'::jsonb) || jsonb_build_object(
      'relay', jsonb_build_object('model', 'gpt-5.4', 'effort', 'low'),
      'sage', jsonb_build_object('model', 'gpt-5.4', 'effort', 'xhigh'),
      'builder', jsonb_build_object('model', 'gpt-5.4', 'effort', 'high'),
      'reviewer', jsonb_build_object('model', 'gpt-5.4', 'effort', 'high'),
      'architect', jsonb_build_object('model', 'gpt-5.4', 'effort', 'high'),
      'sentinel', jsonb_build_object('model', 'gpt-5.3-codex', 'effort', 'medium')
    ),
    true
  ),
  updated_at = now()
WHERE key = 'runtime_provider';
