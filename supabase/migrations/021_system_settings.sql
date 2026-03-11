CREATE TABLE system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO system_settings (key, value)
VALUES (
  'runtime_provider',
  jsonb_build_object(
    'activeProvider', 'anthropic',
    'openaiModelMap', jsonb_build_object(
      'opus', 'gpt-5.3-codex',
      'sonnet', 'gpt-5.1-codex',
      'haiku', 'gpt-5.1-codex-mini'
    )
  )
)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY system_settings_select ON system_settings
  FOR SELECT USING (true);
